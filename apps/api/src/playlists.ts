import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { playlistSchema } from '../../../packages/core/src/validation';
import type { PublicPlaylist, PlaylistRecord } from '../../../packages/core/src/domain';
import type { Repository } from './repository';
import { pathId, requireAuth } from './middleware';

function enrichPlaylist(playlist: PlaylistRecord, videos: Awaited<ReturnType<Repository['listVideos']>>): PublicPlaylist {
  const lookup = new Map(videos.map((video) => [video.id, video]));
  const { userId: _userId, ...safe } = playlist;
  return {
    ...safe,
    videos: [...playlist.items].sort((a, b) => a.position - b.position)
      .map((item) => lookup.get(item.videoId))
      .filter((video): video is NonNullable<typeof video> => Boolean(video))
      .map(({ id, title, durationSeconds, width, height, status }) => ({ id, title, durationSeconds, width, height, status })),
  };
}

export function createPlaylistsRouter(repository: Repository): Router {
  const router = Router();
  const authenticated = requireAuth(repository);

  router.get('/', authenticated, async (request, response, next) => {
    try {
      const [playlists, videos] = await Promise.all([
        repository.listPlaylists(request.userId!), repository.listVideos(request.userId!),
      ]);
      response.json({ playlists: playlists.map((playlist) => enrichPlaylist(playlist, videos)) });
    } catch (error) { next(error); }
  });

  router.post('/', authenticated, async (request, response, next) => {
    try {
      const parsed = playlistSchema.safeParse(request.body);
      if (!parsed.success) return response.status(400).json({ error: parsed.error.issues[0]?.message || 'Playlist details are invalid.', code: 'invalid_playlist' });
      const videoIds = [...new Set(parsed.data.videoIds)];
      const videos = await repository.listVideos(request.userId!);
      const owned = new Set(videos.filter((video) => video.status === 'ready').map((video) => video.id));
      if (videoIds.some((id) => !owned.has(id))) {
        return response.status(400).json({ error: 'Every playlist item must be a ready video in your library.', code: 'invalid_playlist_video' });
      }
      const now = new Date().toISOString();
      const playlist: PlaylistRecord = {
        id: randomUUID(), userId: request.userId!, name: parsed.data.name,
        loopEnabled: parsed.data.loopEnabled,
        items: videoIds.map((videoId, position) => ({ videoId, position })),
        createdAt: now, updatedAt: now,
      };
      const saved = await repository.createPlaylist(playlist);
      response.status(201).json({ playlist: enrichPlaylist(saved, videos) });
    } catch (error) { next(error); }
  });

  router.post('/:id/items', authenticated, async (request, response, next) => {
    try {
      const parsed = z.object({ videoId: z.uuid() }).safeParse(request.body);
      if (!parsed.success) return response.status(400).json({ error: 'Choose a valid video.', code: 'invalid_playlist_video' });
      const video = await repository.getVideo(request.userId!, parsed.data.videoId);
      if (!video || video.status !== 'ready') return response.status(404).json({ error: 'Ready video not found in your library.', code: 'video_not_found' });
      const playlist = await repository.addPlaylistVideos(request.userId!, pathId(request), [video.id]);
      if (!playlist) return response.status(404).json({ error: 'Playlist not found.', code: 'playlist_not_found' });
      const videos = await repository.listVideos(request.userId!);
      response.json({ playlist: enrichPlaylist(playlist, videos) });
    } catch (error) { next(error); }
  });

  router.delete('/:id', authenticated, async (request, response, next) => {
    try {
      const active = await repository.getActiveSession(request.userId!);
      if (active?.playlistId === pathId(request)) return response.status(409).json({ error: 'Stop the active stream before deleting this playlist.', code: 'playlist_in_use' });
      const deleted = await repository.deletePlaylist(request.userId!, pathId(request));
      if (!deleted) return response.status(404).json({ error: 'Playlist not found.', code: 'playlist_not_found' });
      response.status(204).end();
    } catch (error) { next(error); }
  });

  return router;
}
