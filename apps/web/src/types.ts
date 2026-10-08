export type LiveType = 'vertical' | 'horizontal';
export type LiveStatus = 'scheduled' | 'queued' | 'starting' | 'live' | 'reconnecting' | 'stopping' | 'ended' | 'failed';
export type Page = 'dashboard' | 'videos' | 'playlists' | 'live' | 'schedule' | 'youtube' | 'settings' | 'admin';

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'user' | 'admin';
  createdAt: string;
}

export interface Video {
  id: string;
  title: string;
  description: string;
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
  status: 'processing' | 'ready' | 'failed';
  errorMessage: string | null;
  thumbnailUrl: string | null;
  previewAvailable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PlaylistVideo {
  id: string;
  title: string;
  durationSeconds: number;
  width: number;
  height: number;
  status: Video['status'];
}

export interface Playlist {
  id: string;
  name: string;
  loopEnabled: boolean;
  items: Array<{ videoId: string; position: number }>;
  videos: PlaylistVideo[];
  createdAt: string;
}

export interface Destination {
  mode: 'manual' | 'youtube_api';
  serverUrl: string;
  streamKeyConfigured: boolean;
  keyFingerprint: string | null;
  youtubeConnected: boolean;
  channelTitle: string | null;
}

export interface YoutubeStatus {
  configured: boolean;
  connected: boolean;
  channel: { id: string; title: string } | null;
  tokenExpiry: string | null;
}

export interface LiveSession {
  id: string;
  videoId: string | null;
  playlistId: string | null;
  liveType: LiveType;
  status: LiveStatus;
  loopEnabled: boolean;
  skipFailedVideos: boolean;
  currentVideoId: string | null;
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
  destination: 'Manual RTMP' | 'YouTube account' | 'Not configured';
  videoTitle: string | null;
  playlistName: string | null;
}

export interface Schedule {
  id: string;
  sessionId: string;
  scheduledStart: string;
  scheduledEnd: string | null;
  autoStart: boolean;
  status: 'scheduled' | 'started' | 'cancelled' | 'failed' | 'completed';
  createdAt: string;
  session: LiveSession | null;
}

export interface Notification {
  id: string;
  type: string;
  title: string;
  message: string;
  readAt: string | null;
  createdAt: string;
}

export interface Health {
  status: string;
  mode: 'persistent' | 'preview';
  queueConfigured: boolean;
  workerOnline: boolean;
  workerCpuPercent: number | null;
  workerMemoryPercent: number | null;
  storageDriver: string;
  timestamp: string;
}

export interface AdminOverview {
  users: Array<User & { disabled?: boolean }>;
  sessions: LiveSession[];
  storage: { videoCount: number; bytes: number };
  counts: { users: number; videos: number };
}
