export type LiveType = 'vertical' | 'horizontal';
export type SessionStatus =
  | 'scheduled'
  | 'queued'
  | 'starting'
  | 'live'
  | 'reconnecting'
  | 'stopping'
  | 'ended'
  | 'failed';
export type DestinationMode = 'manual' | 'youtube_api';
export type VideoStatus = 'processing' | 'ready' | 'failed';
export type UserRole = 'user' | 'admin';

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  role: UserRole;
  disabled: boolean;
  createdAt: string;
}

export interface SafeUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  createdAt: string;
}

export interface VideoRecord {
  id: string;
  userId: string;
  title: string;
  description: string;
  objectKey: string;
  thumbnailKey: string | null;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string | null;
  audioCodec: string | null;
  liveType: LiveType;
  loopEnabled: boolean;
  status: VideoStatus;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlaylistItemRecord {
  videoId: string;
  position: number;
}

export interface PlaylistRecord {
  id: string;
  userId: string;
  name: string;
  loopEnabled: boolean;
  items: PlaylistItemRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface DestinationRecord {
  id: string;
  userId: string;
  mode: DestinationMode;
  platform: 'youtube';
  serverUrl: string | null;
  encryptedStreamKey: string | null;
  keyFingerprint: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface YoutubeConnectionRecord {
  userId: string;
  channelId: string;
  channelTitle: string;
  encryptedAccessToken: string;
  encryptedRefreshToken: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface LiveSessionRecord {
  id: string;
  userId: string;
  destinationId: string | null;
  videoId: string | null;
  playlistId: string | null;
  liveType: LiveType;
  status: SessionStatus;
  loopEnabled: boolean;
  skipFailedVideos: boolean;
  currentVideoId: string | null;
  encryptedIngestUrl: string | null;
  youtubeBroadcastId: string | null;
  youtubeStreamId: string | null;
  workerId: string | null;
  healthStatus: 'unknown' | 'healthy' | 'warning' | 'error';
  bitrateKbps: number | null;
  fps: number | null;
  droppedFrames: number | null;
  reconnectAttempts: number;
  startedAt: string | null;
  endedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleRecord {
  id: string;
  userId: string;
  sessionId: string;
  scheduledStart: string;
  scheduledEnd: string | null;
  autoStart: boolean;
  status: 'scheduled' | 'started' | 'cancelled' | 'failed' | 'completed';
  createdAt: string;
}

export interface SessionLogRecord {
  id: string | number;
  sessionId: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  createdAt: string;
}

export interface NotificationRecord {
  id: string;
  userId: string;
  type: string;
  title: string;
  message: string;
  readAt: string | null;
  createdAt: string;
}

export interface SessionCreateInput {
  id?: string;
  userId: string;
  destinationId: string | null;
  videoId: string | null;
  playlistId: string | null;
  liveType: LiveType;
  status: SessionStatus;
  loopEnabled: boolean;
  skipFailedVideos?: boolean;
  currentVideoId?: string | null;
  encryptedIngestUrl: string | null;
  youtubeBroadcastId?: string | null;
  youtubeStreamId?: string | null;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
}

export interface PublicVideo extends Omit<VideoRecord, 'objectKey' | 'thumbnailKey' | 'userId'> {
  thumbnailUrl: string | null;
  previewAvailable: boolean;
}

export interface PublicPlaylist extends Omit<PlaylistRecord, 'userId'> {
  videos: Array<Pick<VideoRecord, 'id' | 'title' | 'durationSeconds' | 'width' | 'height' | 'status'>>;
}

export interface PublicLiveSession extends Omit<LiveSessionRecord, 'encryptedIngestUrl' | 'destinationId' | 'userId' | 'workerId' | 'youtubeBroadcastId' | 'youtubeStreamId'> {
  destination: 'Manual RTMP' | 'YouTube account' | 'Not configured';
  videoTitle: string | null;
  playlistName: string | null;
}

export function toSafeUser(user: UserRecord): SafeUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt,
  };
}
