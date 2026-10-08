import { Router } from 'express';
import { liveStartSchema } from '../../../packages/core/src/validation';
import type { LiveSessionRecord, PublicLiveSession, ScheduleRecord } from '../../../packages/core/src/domain';
import type { Repository } from './repository';
import { ObjectStorage } from './storage';
import { QueueService } from './queue';
import { prepareLiveSession } from './live-service';
import { pathId, requireAuth } from './middleware';
import { youtubeService } from './youtube-service';

export async function publicSession(repository: Repository, session: LiveSessionRecord): Promise<PublicLiveSession> {
  const [{ encryptedIngestUrl: _encrypted, destinationId: _destinationId, userId: _userId, workerId: _workerId, youtubeBroadcastId: _broadcastId, youtubeStreamId: _streamId, ...safe }, destination, video, playlist] = await Promise.all([
    Promise.resolve(session),
    repository.getDestination(session.userId),
    session.currentVideoId ? repository.getVideo(session.userId, session.currentVideoId) : Promise.resolve(null),
    session.playlistId ? repository.getPlaylist(session.userId, session.playlistId) : Promise.resolve(null),
  ]);
  return {
    ...safe,
    destination: destination?.mode === 'youtube_api' ? 'YouTube account' : destination?.encryptedStreamKey ? 'Manual RTMP' : 'Not configured',
    videoTitle: video?.title || null,
    playlistName: playlist?.name || null,
  };
}

async function scheduleForSession(repository: Repository, userId: string, sessionId: string): Promise<ScheduleRecord | null> {
  return (await repository.listSchedules(userId)).find((item) => item.sessionId === sessionId) || null;
}

export function createLiveRouter(repository: Repository, storage: ObjectStorage, queue: QueueService): Router {
  const router = Router();
  const authenticated = requireAuth(repository);

  router.get('/current', authenticated, async (request, response, next) => {
    try {
      const session = await repository.getActiveSession(request.userId!);
      response.json({ session: session ? await publicSession(repository, session) : null });
    } catch (error) { next(error); }
  });

  router.get('/', authenticated, async (request, response, next) => {
    try {
      const sessions = await repository.listSessions(request.userId!);
      response.json({ sessions: await Promise.all(sessions.map((session) => publicSession(repository, session))) });
    } catch (error) { next(error); }
  });

  router.post('/', authenticated, async (request, response, next) => {
    try {
      const parsed = liveStartSchema.safeParse(request.body);
      if (!parsed.success) return response.status(400).json({ error: parsed.error.issues[0]?.message || 'Live setup is invalid.', code: 'invalid_live_setup' });
      if (!queue.configured) return response.status(503).json({ error: 'Live streaming is not available until Redis and the streaming worker are running.', code: 'worker_unavailable' });
      await queue.waitUntilReady();
      if (!(await queue.workerOnline())) return response.status(503).json({ error: 'No streaming worker heartbeat is available. Start the FFmpeg worker and try again.', code: 'worker_offline' });
      const session = await prepareLiveSession(repository, storage, request.userId!, parsed.data);
      try {
        await queue.enqueueStart(session.id);
      } catch (error) {
        await repository.updateSession(session.id, { status: 'failed', endedAt: new Date().toISOString(), errorMessage: 'Could not queue the streaming worker.' });
        throw error;
      }
      await repository.appendLog(session.id, 'info', 'Live job queued for the streaming worker.');
      await repository.createNotification(request.userId!, 'live_queued', 'Live is preparing', 'The server worker is preparing your stream.');
      response.status(202).json({ session: await publicSession(repository, session) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not start this stream.';
      const status = /already active|scheduled for this account/.test(message) ? 409 : /preview|Configure|Connect|Save|ready video|source video|playlist/i.test(message) ? 422 : 503;
      response.status(status).json({ error: message, code: status === 409 ? 'session_conflict' : 'live_start_failed' });
    }
  });

  router.get('/:id/logs', authenticated, async (request, response, next) => {
    try {
      const session = await repository.getSessionForUser(request.userId!, pathId(request));
      if (!session) return response.status(404).json({ error: 'Live session not found.', code: 'session_not_found' });
      response.json({ logs: await repository.listLogs(session.id) });
    } catch (error) { next(error); }
  });

  router.post('/:id/stop', authenticated, async (request, response, next) => {
    try {
      const session = await repository.getSessionForUser(request.userId!, pathId(request));
      if (!session) return response.status(404).json({ error: 'Live session not found.', code: 'session_not_found' });
      if (['ended', 'failed'].includes(session.status)) return response.json({ session: await publicSession(repository, session) });
      if (session.status === 'scheduled' || session.status === 'queued') {
        await queue.cancelScheduled(session.id);
        const schedule = await scheduleForSession(repository, request.userId!, session.id);
        if (schedule) await repository.updateSchedule(schedule.id, 'cancelled');
        const stopped = await repository.updateSession(session.id, { status: 'ended', endedAt: new Date().toISOString(), workerId: null });
        await repository.appendLog(session.id, 'info', 'Queued live session cancelled by the user.');
        await repository.createNotification(request.userId!, 'live_stopped', 'Live stopped', 'The queued stream was cancelled.');
        return response.json({ session: await publicSession(repository, stopped!) });
      }
      if (!queue.configured) return response.status(503).json({ error: 'The worker control channel is unavailable.', code: 'worker_unavailable' });
      if (!(await queue.workerOnline())) return response.status(503).json({ error: 'No streaming worker heartbeat is available to stop this stream safely.', code: 'worker_offline' });
      await repository.updateSession(session.id, { status: 'stopping' });
      await queue.publishControl(session.id, 'stop');
      await repository.appendLog(session.id, 'info', 'Stop requested by user.');
      response.json({ session: await publicSession(repository, (await repository.getSession(session.id))!) });
    } catch (error) { next(error); }
  });

  router.post('/:id/restart', authenticated, async (request, response, next) => {
    try {
      const session = await repository.getSessionForUser(request.userId!, pathId(request));
      if (!session) return response.status(404).json({ error: 'Live session not found.', code: 'session_not_found' });
      if (!queue.configured) return response.status(503).json({ error: 'The worker control channel is unavailable.', code: 'worker_unavailable' });
      await queue.waitUntilReady();
      if (!(await queue.workerOnline())) return response.status(503).json({ error: 'No streaming worker heartbeat is available.', code: 'worker_offline' });
      if (['starting', 'live', 'reconnecting'].includes(session.status)) {
        await repository.updateSession(session.id, { status: 'reconnecting', errorMessage: null, reconnectAttempts: 0 });
        await queue.publishControl(session.id, 'restart');
        await repository.appendLog(session.id, 'warn', 'Restart requested by user.');
        return response.json({ session: await publicSession(repository, (await repository.getSession(session.id))!) });
      }
      if (['scheduled', 'queued', 'stopping'].includes(session.status)) {
        return response.status(409).json({ error: 'This session cannot be restarted in its current state.', code: 'invalid_session_state' });
      }
      const destination = await repository.getDestination(request.userId!);
      if (!destination) return response.status(422).json({ error: 'Configure a YouTube destination first.', code: 'destination_required' });
      const renewed = await prepareLiveSession(repository, storage, request.userId!, {
        videoId: session.videoId || undefined,
        playlistId: session.playlistId || undefined,
        liveType: session.liveType,
        loopEnabled: session.loopEnabled,
        skipFailedVideos: session.skipFailedVideos,
        privacyStatus: 'unlisted',
      });
      await queue.enqueueStart(renewed.id);
      await repository.appendLog(renewed.id, 'info', `Restarted from previous session ${session.id}.`);
      response.status(202).json({ session: await publicSession(repository, renewed) });
    } catch (error) { next(error); }
  });

  return router;
}
