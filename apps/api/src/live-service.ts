import { randomUUID } from 'node:crypto';
import { decryptSecret, encryptSecret } from '../../../packages/core/src/security';
import type { LiveSessionRecord, SessionCreateInput, VideoRecord } from '../../../packages/core/src/domain';
import { validateYoutubeIngest } from '../../../packages/core/src/validation';
import { config } from './config';
import type { Repository } from './repository';
import { ObjectStorage } from './storage';
import { youtubeService } from './youtube-service';

export interface LiveSelection {
  videoId?: string;
  playlistId?: string;
  liveType: 'vertical' | 'horizontal';
  loopEnabled: boolean;
  skipFailedVideos: boolean;
  privacyStatus: 'public' | 'unlisted' | 'private';
}

export async function prepareLiveSession(
  repository: Repository,
  storage: ObjectStorage,
  userId: string,
  selection: LiveSelection,
  options: { scheduledStart?: string; status?: 'queued' | 'scheduled' } = {},
): Promise<LiveSessionRecord> {
  if (!repository.persistent) {
    throw new Error('Streaming is disabled in the in-memory preview. Start the PostgreSQL, Redis, storage and worker services first.');
  }
  const existing = await repository.getActiveSession(userId);
  if (existing) throw new Error('A live session is already active or scheduled for this account.');

  let videoId = selection.videoId || null;
  let playlistId = selection.playlistId || null;
  let currentVideoId = videoId;
  let title = 'Maya live stream';
  let description = '';
  let sources: Array<Awaited<ReturnType<Repository['getVideo']>>>;

  if (videoId) {
    const video = await repository.getVideo(userId, videoId);
    if (!video || video.status !== 'ready') throw new Error('Choose a processed, ready video in your library.');
    title = video.title;
    description = video.description;
    sources = [video];
  } else if (playlistId) {
    const playlist = await repository.getPlaylist(userId, playlistId);
    if (!playlist) throw new Error('Playlist not found.');
    const orderedItems = [...playlist.items].sort((a, b) => a.position - b.position);
    if (orderedItems.length === 0) throw new Error('Add at least one ready video to the playlist first.');
    const resolved = await Promise.all(orderedItems.map((item) => repository.getVideo(userId, item.videoId)));
    if (resolved.some((video) => !video || video.status !== 'ready') && !selection.skipFailedVideos) {
      throw new Error('Every playlist item must be a ready video in your library. Enable skip failed items to continue past unavailable videos.');
    }
    sources = resolved.filter((video): video is VideoRecord => Boolean(video && video.status === 'ready'));
    if (sources.length === 0) throw new Error('The playlist has no ready videos to stream.');
    const first = sources[0]!;
    currentVideoId = first.id;
    title = playlist.name;
    description = `Maya playlist: ${playlist.name}`;
  } else {
    throw new Error('Choose a video or playlist to stream.');
  }

  const availableSources: VideoRecord[] = [];
  for (const video of sources) {
    if (!video) continue;
    if (!(await storage.exists(video.objectKey))) {
      if (playlistId && selection.skipFailedVideos) continue;
      throw new Error('A source video is missing from storage. Re-upload the video before starting this stream.');
    }
    availableSources.push(video);
  }
  if (availableSources.length === 0) throw new Error('No playlist videos are available in storage.');
  if (playlistId) {
    sources = availableSources;
    currentVideoId = availableSources[0].id;
  }

  const destination = await repository.getDestination(userId);
  if (!destination) throw new Error('Configure a YouTube destination before starting live.');
  let ingestUrl: string;
  let broadcastId: string | null = null;
  let streamId: string | null = null;
  if (destination.mode === 'manual') {
    if (!destination.serverUrl || !destination.encryptedStreamKey) {
      throw new Error('Save a YouTube RTMP/RTMPS server URL and stream key first.');
    }
    const streamKey = decryptSecret(destination.encryptedStreamKey, config.encryptionSecret);
    ingestUrl = validateYoutubeIngest(destination.serverUrl, streamKey);
  } else {
    const start = options.scheduledStart || new Date(Date.now() + 30_000).toISOString();
    const ingest = await youtubeService.createIngest(repository, {
      userId,
      title,
      description,
      privacyStatus: selection.privacyStatus,
      scheduledStart: start,
    });
    ingestUrl = ingest.ingestUrl;
    broadcastId = ingest.broadcastId;
    streamId = ingest.streamId;
  }

  const input: SessionCreateInput = {
    id: randomUUID(), userId, destinationId: destination.id,
    videoId, playlistId, liveType: selection.liveType,
    status: options.status || 'queued', loopEnabled: selection.loopEnabled,
    skipFailedVideos: selection.skipFailedVideos,
    currentVideoId, encryptedIngestUrl: encryptSecret(ingestUrl, config.encryptionSecret),
    youtubeBroadcastId: broadcastId, youtubeStreamId: streamId,
  };
  return repository.createSession(input);
}
