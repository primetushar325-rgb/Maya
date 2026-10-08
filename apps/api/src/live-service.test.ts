import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LiveSessionRecord, PlaylistRecord, SessionCreateInput, VideoRecord } from '../../../packages/core/src/domain';
import { encryptSecret } from '../../../packages/core/src/security';
import { config } from './config';
import { prepareLiveSession } from './live-service';
import type { Repository } from './repository';
import type { ObjectStorage } from './storage';

const timestamp = '2026-01-01T00:00:00.000Z';
const userId = 'user-1';
const playlistId = 'playlist-1';

function makeVideo(id: string, status: VideoRecord['status'] = 'ready'): VideoRecord {
  return {
    id, userId, title: id, description: '', objectKey: `${id}.mp4`, thumbnailKey: null,
    originalName: `${id}.mp4`, mimeType: 'video/mp4', sizeBytes: 100, durationSeconds: 10,
    width: 1920, height: 1080, fps: 30, videoCodec: 'h264', audioCodec: 'aac', liveType: 'horizontal',
    loopEnabled: false, status, errorMessage: null, createdAt: timestamp, updatedAt: timestamp,
  };
}

function makeHarness(videos: VideoRecord[], existingObjects: string[]) {
  const byId = new Map(videos.map((video) => [video.id, video]));
  const playlist: PlaylistRecord = {
    id: playlistId, userId, name: 'Test playlist', loopEnabled: true,
    items: videos.map((video, position) => ({ videoId: video.id, position })),
    createdAt: timestamp, updatedAt: timestamp,
  };
  let createdInput: SessionCreateInput | null = null;
  const repository = {
    persistent: true,
    getActiveSession: async () => null,
    getPlaylist: async () => playlist,
    getVideo: async (_userId: string, id: string) => byId.get(id) || null,
    getDestination: async () => ({
      id: 'destination-1', userId, mode: 'manual', platform: 'youtube',
      serverUrl: 'rtmps://a.rtmps.youtube.com/live2',
      encryptedStreamKey: encryptSecret('sample_stream_key', config.encryptionSecret),
      keyFingerprint: null, createdAt: timestamp, updatedAt: timestamp,
    }),
    createSession: async (input: SessionCreateInput) => {
      createdInput = input;
      return {
        ...input, id: input.id || 'session-1', destinationId: input.destinationId, videoId: input.videoId,
        playlistId: input.playlistId, status: input.status, loopEnabled: input.loopEnabled,
        skipFailedVideos: input.skipFailedVideos ?? false, currentVideoId: input.currentVideoId || null,
        encryptedIngestUrl: input.encryptedIngestUrl, youtubeBroadcastId: null, youtubeStreamId: null,
        workerId: null, healthStatus: 'unknown', bitrateKbps: null, fps: null, droppedFrames: null,
        reconnectAttempts: 0, startedAt: null, endedAt: null, errorMessage: null,
        createdAt: timestamp, updatedAt: timestamp,
      } as LiveSessionRecord;
    },
  };
  const storage = { exists: async (key: string) => existingObjects.includes(key) };
  return {
    repository: repository as unknown as Repository,
    storage: storage as unknown as ObjectStorage,
    getCreatedInput: () => createdInput,
  };
}

const selection = (skipFailedVideos: boolean) => ({
  playlistId, liveType: 'horizontal' as const, loopEnabled: true,
  skipFailedVideos, privacyStatus: 'unlisted' as const,
});

test('playlist start rejects unavailable videos unless skipping is enabled', async () => {
  const videos = [makeVideo('ready'), makeVideo('failed', 'failed')];
  const harness = makeHarness(videos, ['ready.mp4', 'failed.mp4']);

  await assert.rejects(
    prepareLiveSession(harness.repository, harness.storage, userId, selection(false)),
    /Every playlist item must be a ready video/,
  );
  assert.equal(harness.getCreatedInput(), null);
});

test('playlist start filters failed and missing objects when skip is enabled', async () => {
  const videos = [makeVideo('missing-object'), makeVideo('failed', 'failed'), makeVideo('ready')];
  const harness = makeHarness(videos, ['failed.mp4', 'ready.mp4']);

  const session = await prepareLiveSession(harness.repository, harness.storage, userId, selection(true));

  assert.equal(session.currentVideoId, 'ready');
  assert.equal(session.skipFailedVideos, true);
  assert.equal(harness.getCreatedInput()?.currentVideoId, 'ready');
});

test('playlist start still fails when skipping would leave no available source', async () => {
  const videos = [makeVideo('unavailable', 'failed')];
  const harness = makeHarness(videos, []);

  await assert.rejects(
    prepareLiveSession(harness.repository, harness.storage, userId, selection(true)),
    /no ready videos to stream/i,
  );
});
