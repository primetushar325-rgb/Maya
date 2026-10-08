import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { scheduleSchema } from '../../../packages/core/src/validation';
import type { ScheduleRecord } from '../../../packages/core/src/domain';
import type { Repository } from './repository';
import { ObjectStorage } from './storage';
import { QueueService } from './queue';
import { prepareLiveSession } from './live-service';
import { pathId, requireAuth } from './middleware';
import { youtubeService } from './youtube-service';
import { publicSession } from './live';

export function createSchedulesRouter(repository: Repository, storage: ObjectStorage, queue: QueueService): Router {
  const router = Router();
  const authenticated = requireAuth(repository);

  router.get('/', authenticated, async (request, response, next) => {
    try {
      const schedules = await repository.listSchedules(request.userId!);
      const items = await Promise.all(schedules.map(async (schedule) => {
        const session = await repository.getSessionForUser(request.userId!, schedule.sessionId);
        return { ...schedule, session: session ? await publicSession(repository, session) : null };
      }));
      response.json({ schedules: items });
    } catch (error) { next(error); }
  });

  router.post('/', authenticated, async (request, response, next) => {
    try {
      const parsed = scheduleSchema.safeParse(request.body);
      if (!parsed.success) return response.status(400).json({ error: parsed.error.issues[0]?.message || 'Schedule details are invalid.', code: 'invalid_schedule' });
      const startMs = Date.parse(parsed.data.scheduledStart);
      if (startMs < Date.now() + 30_000) return response.status(400).json({ error: 'Choose a start time at least 30 seconds in the future.', code: 'schedule_too_soon' });
      if (startMs > Date.now() + 365 * 24 * 60 * 60 * 1000) return response.status(400).json({ error: 'Schedule start must be within the next year.', code: 'schedule_too_far' });
      if (!repository.persistent || !queue.configured) {
        return response.status(503).json({ error: 'Scheduling requires PostgreSQL, Redis and the streaming worker. The in-memory preview cannot run delayed jobs.', code: 'scheduler_unavailable' });
      }
      await queue.waitUntilReady();
      if (!(await queue.workerOnline())) return response.status(503).json({ error: 'No streaming worker heartbeat is available for scheduled lives.', code: 'worker_offline' });
      const session = await prepareLiveSession(repository, storage, request.userId!, parsed.data, {
        scheduledStart: parsed.data.scheduledStart,
        status: 'scheduled',
      });
      const schedule: ScheduleRecord = {
        id: randomUUID(), userId: request.userId!, sessionId: session.id,
        scheduledStart: parsed.data.scheduledStart,
        scheduledEnd: parsed.data.scheduledEnd || null,
        autoStart: parsed.data.autoStart,
        status: 'scheduled',
        createdAt: new Date().toISOString(),
      };
      try {
        await repository.createSchedule(schedule);
        if (schedule.autoStart) await queue.enqueueStart(session.id, startMs - Date.now());
        if (schedule.scheduledEnd) await queue.enqueueStopAt(session.id, schedule.scheduledEnd);
      } catch (error) {
        await repository.updateSession(session.id, { status: 'failed', endedAt: new Date().toISOString(), errorMessage: 'Could not register the scheduled worker job.' });
        throw error;
      }
      await repository.appendLog(session.id, 'info', schedule.autoStart ? 'Scheduled live job registered.' : 'Schedule saved without auto-start.');
      response.status(201).json({ schedule: { ...schedule, session: await publicSession(repository, session) } });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not create this schedule.';
      const conflict = /already active|scheduled for this account/.test(message);
      response.status(conflict ? 409 : 422).json({ error: message, code: conflict ? 'session_conflict' : 'schedule_failed' });
    }
  });

  router.post('/:id/start', authenticated, async (request, response, next) => {
    try {
      const schedule = await repository.getScheduleForUser(request.userId!, pathId(request));
      if (!schedule || schedule.status !== 'scheduled') return response.status(404).json({ error: 'Pending schedule not found.', code: 'schedule_not_found' });
      if (schedule.autoStart) return response.status(409).json({ error: 'This schedule already has an automatic start job.', code: 'auto_start_enabled' });
      await queue.waitUntilReady();
      if (!(await queue.workerOnline())) return response.status(503).json({ error: 'No streaming worker heartbeat is available.', code: 'worker_offline' });
      const session = await repository.getSessionForUser(request.userId!, schedule.sessionId);
      if (!session || session.status !== 'scheduled') return response.status(409).json({ error: 'Scheduled session is no longer available.', code: 'invalid_session_state' });
      await queue.enqueueStart(session.id);
      await repository.updateSchedule(schedule.id, 'started');
      response.status(202).json({ accepted: true, sessionId: session.id });
    } catch (error) { next(error); }
  });

  router.delete('/:id', authenticated, async (request, response, next) => {
    try {
      const schedule = await repository.getScheduleForUser(request.userId!, pathId(request));
      if (!schedule || schedule.status !== 'scheduled') return response.status(404).json({ error: 'Pending schedule not found.', code: 'schedule_not_found' });
      await queue.cancelScheduled(schedule.sessionId);
      await repository.updateSchedule(schedule.id, 'cancelled');
      const session = await repository.getSessionForUser(request.userId!, schedule.sessionId);
      if (session) {
        await repository.updateSession(session.id, { status: 'ended', endedAt: new Date().toISOString(), workerId: null });
        if (session.youtubeBroadcastId) {
          await youtubeService.completeBroadcast(repository, request.userId!, session.youtubeBroadcastId).catch(() => undefined);
        }
      }
      response.status(204).end();
    } catch (error) { next(error); }
  });

  return router;
}
