import { z } from 'zod';

export const liveTypeSchema = z.enum(['vertical', 'horizontal']);

export const loginSchema = z.object({
  email: z.email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(256),
});

export const videoMetadataSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().max(4000).default(''),
  liveType: liveTypeSchema.default('horizontal'),
  loopEnabled: z.boolean().default(false),
});

export const playlistSchema = z.object({
  name: z.string().trim().min(1).max(120),
  loopEnabled: z.boolean().default(true),
  videoIds: z.array(z.uuid()).max(250).default([]),
});

export const updateVideoSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  description: z.string().max(4000).optional(),
  liveType: liveTypeSchema.optional(),
  loopEnabled: z.boolean().optional(),
});

export const destinationSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('manual'),
    serverUrl: z.string().trim().min(1).max(300),
    streamKey: z.string().trim().min(4).max(300),
  }),
  z.object({ mode: z.literal('youtube_api') }),
]);

export const liveStartSchema = z.object({
  videoId: z.uuid().optional(),
  playlistId: z.uuid().optional(),
  liveType: liveTypeSchema,
  loopEnabled: z.boolean().default(false),
  skipFailedVideos: z.boolean().default(false),
  privacyStatus: z.enum(['public', 'unlisted', 'private']).default('unlisted'),
}).refine((value) => Boolean(value.videoId) !== Boolean(value.playlistId), {
  message: 'Choose exactly one video or playlist.',
  path: ['videoId'],
});

export const scheduleSchema = liveStartSchema.extend({
  scheduledStart: z.iso.datetime({ offset: true }),
  scheduledEnd: z.iso.datetime({ offset: true }).optional(),
  autoStart: z.boolean().default(true),
}).refine((value) => !value.scheduledEnd || Date.parse(value.scheduledEnd) > Date.parse(value.scheduledStart), {
  message: 'Scheduled end must be after the start time.',
  path: ['scheduledEnd'],
});

export function validateYoutubeIngest(serverUrl: string, streamKey: string): string {
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw new Error('Enter a valid YouTube RTMP/RTMPS server URL.');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    !['rtmp:', 'rtmps:'].includes(parsed.protocol) ||
    !hostname.endsWith('.youtube.com') ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !parsed.pathname ||
    parsed.pathname === '/'
  ) {
    throw new Error('Use a YouTube RTMP/RTMPS ingest URL from YouTube Studio.');
  }
  if (!/^[A-Za-z0-9_-]{4,300}$/.test(streamKey)) {
    throw new Error('Stream key format is invalid.');
  }
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/$/, '')}/${streamKey}`;
}

export function validateYoutubeIngestAddress(serverUrl: string, streamKey: string): string {
  return validateYoutubeIngest(serverUrl, streamKey);
}

export function parseFormBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  return value === 'true' || value === '1' || value === 'on';
}
