import { Router } from 'express';
import { toSafeUser } from '../../../packages/core/src/domain';
import type { Repository } from './repository';
import { pathId, requireAdmin, requireAuth } from './middleware';
import { QueueService } from './queue';

export function createAdminRouter(repository: Repository, queue: QueueService): Router {
  const router = Router();
  router.use(requireAuth(repository), requireAdmin);

  router.get('/overview', async (_request, response, next) => {
    try {
      const [summary, users] = await Promise.all([repository.getAdminSummary(), repository.listUsers()]);
      response.json({
        users: users.map((user) => ({ ...toSafeUser(user), disabled: user.disabled })),
        sessions: summary.sessions.map(({ encryptedIngestUrl: _secret, destinationId: _destination, ...session }) => session),
        storage: { videoCount: summary.videos, bytes: summary.storageBytes },
        counts: { users: summary.users, videos: summary.videos },
      });
    } catch (error) { next(error); }
  });

  router.patch('/users/:id', async (request, response, next) => {
    try {
      if (typeof request.body.disabled !== 'boolean') return response.status(400).json({ error: 'Choose whether the user should be disabled.', code: 'invalid_user_update' });
      if (pathId(request) === request.userId && request.body.disabled) return response.status(409).json({ error: 'You cannot disable your own admin account.', code: 'self_disable' });
      const user = await repository.getUserById(pathId(request));
      if (!user) return response.status(404).json({ error: 'User not found.', code: 'user_not_found' });
      await repository.setUserDisabled(user.id, request.body.disabled);
      response.json({ user: { ...toSafeUser(user), disabled: request.body.disabled } });
    } catch (error) { next(error); }
  });

  router.post('/sessions/:id/stop', async (request, response, next) => {
    try {
      const session = await repository.getSession(pathId(request));
      if (!session) return response.status(404).json({ error: 'Live session not found.', code: 'session_not_found' });
      if (!queue.configured) return response.status(503).json({ error: 'Worker control channel is unavailable.', code: 'worker_unavailable' });
      await repository.updateSession(session.id, { status: 'stopping' });
      await queue.publishControl(session.id, 'stop');
      await repository.appendLog(session.id, 'warn', 'Stream stopped by an administrator.');
      response.json({ accepted: true });
    } catch (error) { next(error); }
  });

  router.get('/sessions/:id/logs', async (request, response, next) => {
    try {
      const session = await repository.getSession(pathId(request));
      if (!session) return response.status(404).json({ error: 'Live session not found.', code: 'session_not_found' });
      response.json({ logs: await repository.listLogs(session.id, 250) });
    } catch (error) { next(error); }
  });

  return router;
}
