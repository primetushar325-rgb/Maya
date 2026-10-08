import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { encryptSecret, createOAuthState, shortFingerprint } from '../../../packages/core/src/security';
import { destinationSchema, validateYoutubeIngest } from '../../../packages/core/src/validation';
import type { DestinationRecord } from '../../../packages/core/src/domain';
import type { Repository } from './repository';
import { config } from './config';
import { requireAuth } from './middleware';
import { clearOAuthStateCookie, readOAuthStateCookie, setOAuthStateCookie } from './middleware';
import { youtubeApi, youtubeService } from './youtube-service';

function safeDestination(destination: DestinationRecord | null, connected: boolean, channelTitle: string | null) {
  return {
    mode: destination?.mode || 'manual',
    serverUrl: destination?.serverUrl || '',
    streamKeyConfigured: Boolean(destination?.encryptedStreamKey),
    keyFingerprint: destination?.keyFingerprint || null,
    youtubeConnected: connected,
    channelTitle,
  };
}

export function createYoutubeRouter(repository: Repository): Router {
  const router = Router();
  const authenticated = requireAuth(repository);

  router.get('/destination', authenticated, async (request, response, next) => {
    try {
      const [destination, connection] = await Promise.all([
        repository.getDestination(request.userId!),
        repository.getYoutubeConnection(request.userId!),
      ]);
      response.json({ destination: safeDestination(destination, Boolean(connection), connection?.channelTitle || null) });
    } catch (error) { next(error); }
  });

  router.put('/destination', authenticated, async (request, response, next) => {
    try {
      const parsed = destinationSchema.safeParse(request.body);
      if (!parsed.success) return response.status(400).json({ error: parsed.error.issues[0]?.message || 'Destination settings are invalid.', code: 'invalid_destination' });
      const userId = request.userId!;
      const existing = await repository.getDestination(userId);
      const now = new Date().toISOString();
      let values: Pick<DestinationRecord, 'mode' | 'serverUrl' | 'encryptedStreamKey' | 'keyFingerprint'>;
      if (parsed.data.mode === 'manual') {
        validateYoutubeIngest(parsed.data.serverUrl, parsed.data.streamKey);
        values = {
          mode: 'manual',
          serverUrl: parsed.data.serverUrl.replace(/\/$/, ''),
          encryptedStreamKey: encryptSecret(parsed.data.streamKey, config.encryptionSecret),
          keyFingerprint: shortFingerprint(parsed.data.streamKey),
        };
      } else {
        const connection = await repository.getYoutubeConnection(userId);
        if (!connection) return response.status(409).json({ error: 'Connect a YouTube account before choosing API mode.', code: 'youtube_not_connected' });
        values = {
          mode: 'youtube_api',
          serverUrl: null,
          encryptedStreamKey: null,
          keyFingerprint: null,
        };
      }
      const saved = await repository.saveDestination({
        id: existing?.id || randomUUID(), userId, platform: 'youtube', ...values,
        createdAt: existing?.createdAt || now, updatedAt: now,
      });
      const connection = await repository.getYoutubeConnection(userId);
      response.json({ destination: safeDestination(saved, Boolean(connection), connection?.channelTitle || null) });
    } catch (error) { next(error); }
  });

  router.post('/destination/test', authenticated, async (request, response) => {
    const parsed = destinationSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: parsed.error.issues[0]?.message || 'Destination settings are invalid.', code: 'invalid_destination' });
    if (parsed.data.mode === 'youtube_api') {
      const connection = await repository.getYoutubeConnection(request.userId!);
      if (!connection) return response.status(409).json({ error: 'Connect a YouTube account first.', code: 'youtube_not_connected' });
      return response.json({ valid: true, message: `Connected to ${connection.channelTitle}. Ingest health is verified when a stream starts.` });
    }
    try {
      validateYoutubeIngest(parsed.data.serverUrl, parsed.data.streamKey);
      response.json({ valid: true, message: 'YouTube ingest URL and key format look valid. RTMP connectivity is checked during a live ingest.' });
    } catch (error) {
      response.status(400).json({ valid: false, error: error instanceof Error ? error.message : 'Invalid YouTube destination.' });
    }
  });

  router.get('/youtube/status', authenticated, async (request, response, next) => {
    try {
      const connection = await repository.getYoutubeConnection(request.userId!);
      response.json({
        configured: youtubeApi.isConfigured(),
        connected: Boolean(connection),
        channel: connection ? { id: connection.channelId, title: connection.channelTitle } : null,
        tokenExpiry: connection?.expiresAt || null,
      });
    } catch (error) { next(error); }
  });

  router.get('/youtube/connect', authenticated, (request, response, next) => {
    try {
      if (!youtubeApi.isConfigured()) return response.status(503).json({ error: 'Google OAuth credentials are not configured on this server.', code: 'youtube_oauth_unconfigured' });
      const state = createOAuthState();
      setOAuthStateCookie(response, state);
      response.redirect(302, youtubeApi.authorizationUrl(state));
    } catch (error) { next(error); }
  });

  router.get('/youtube/callback', authenticated, async (request, response) => {
    const returnedState = typeof request.query.state === 'string' ? request.query.state : '';
    const cookieState = readOAuthStateCookie(request);
    clearOAuthStateCookie(response);
    if (!returnedState || !cookieState || returnedState !== cookieState) {
      return response.redirect(`${config.appOrigin}/?view=youtube&oauth=state_error`);
    }
    if (typeof request.query.error === 'string') {
      return response.redirect(`${config.appOrigin}/?view=youtube&oauth=denied`);
    }
    const code = typeof request.query.code === 'string' ? request.query.code : '';
    if (!code) return response.redirect(`${config.appOrigin}/?view=youtube&oauth=missing_code`);
    try {
      const channel = await youtubeService.connectWithCode(repository, request.userId!, code);
      await repository.createNotification(request.userId!, 'youtube_connected', 'YouTube connected', `${channel.channelTitle} is ready as a streaming destination.`);
      response.redirect(`${config.appOrigin}/?view=youtube&oauth=connected`);
    } catch {
      response.redirect(`${config.appOrigin}/?view=youtube&oauth=failed`);
    }
  });

  router.delete('/youtube/status', authenticated, async (request, response, next) => {
    try {
      await repository.deleteYoutubeConnection(request.userId!);
      const destination = await repository.getDestination(request.userId!);
      if (destination?.mode === 'youtube_api') {
        await repository.saveDestination({
          ...destination, mode: 'manual', serverUrl: null, encryptedStreamKey: null, keyFingerprint: null,
          updatedAt: new Date().toISOString(),
        });
      }
      response.status(204).end();
    } catch (error) { next(error); }
  });

  return router;
}
