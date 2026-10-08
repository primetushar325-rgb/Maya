import { Router } from 'express';
import type { Repository } from './repository';
import { requireAuth } from './middleware';

export function createNotificationsRouter(repository: Repository): Router {
  const router = Router();
  router.use(requireAuth(repository));

  router.get('/', async (request, response, next) => {
    try {
      response.json({ notifications: await repository.listNotifications(request.userId!) });
    } catch (error) { next(error); }
  });

  router.post('/read', async (request, response, next) => {
    try {
      await repository.markNotificationsRead(request.userId!);
      response.status(204).end();
    } catch (error) { next(error); }
  });

  return router;
}
