CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  disabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS videos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  object_key TEXT NOT NULL,
  thumbnail_key TEXT,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  duration_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  fps DOUBLE PRECISION NOT NULL DEFAULT 0,
  video_codec TEXT,
  audio_codec TEXT,
  live_type TEXT NOT NULL DEFAULT 'horizontal' CHECK (live_type IN ('vertical', 'horizontal')),
  loop_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'failed')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE videos ADD COLUMN IF NOT EXISTS loop_enabled BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS videos_owner_created_idx ON videos(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS playlists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  loop_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS playlists_owner_idx ON playlists(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS playlist_items (
  playlist_id UUID NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (playlist_id, video_id),
  UNIQUE (playlist_id, position)
);

CREATE TABLE IF NOT EXISTS streaming_destinations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'manual' CHECK (mode IN ('manual', 'youtube_api')),
  platform TEXT NOT NULL DEFAULT 'youtube',
  server_url TEXT,
  encrypted_stream_key TEXT,
  key_fingerprint TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS youtube_connections (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  channel_title TEXT NOT NULL,
  encrypted_access_token TEXT NOT NULL,
  encrypted_refresh_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS live_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  destination_id UUID REFERENCES streaming_destinations(id) ON DELETE SET NULL,
  video_id UUID REFERENCES videos(id) ON DELETE SET NULL,
  playlist_id UUID REFERENCES playlists(id) ON DELETE SET NULL,
  live_type TEXT NOT NULL CHECK (live_type IN ('vertical', 'horizontal')),
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'queued', 'starting', 'live', 'reconnecting', 'stopping', 'ended', 'failed')),
  loop_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  skip_failed_videos BOOLEAN NOT NULL DEFAULT FALSE,
  current_video_id UUID REFERENCES videos(id) ON DELETE SET NULL,
  encrypted_ingest_url TEXT,
  youtube_broadcast_id TEXT,
  youtube_stream_id TEXT,
  worker_id TEXT,
  health_status TEXT NOT NULL DEFAULT 'unknown',
  bitrate_kbps INTEGER,
  fps DOUBLE PRECISION,
  dropped_frames INTEGER,
  reconnect_attempts INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((video_id IS NOT NULL) <> (playlist_id IS NOT NULL))
);
ALTER TABLE live_sessions ADD COLUMN IF NOT EXISTS dropped_frames INTEGER;
ALTER TABLE live_sessions ADD COLUMN IF NOT EXISTS skip_failed_videos BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS live_sessions_owner_created_idx ON live_sessions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS live_sessions_status_idx ON live_sessions(status);
CREATE UNIQUE INDEX IF NOT EXISTS live_sessions_one_active_per_user
  ON live_sessions(user_id)
  WHERE status IN ('scheduled', 'queued', 'starting', 'live', 'reconnecting', 'stopping');

CREATE TABLE IF NOT EXISTS scheduled_lives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id UUID NOT NULL UNIQUE REFERENCES live_sessions(id) ON DELETE CASCADE,
  scheduled_start TIMESTAMPTZ NOT NULL,
  scheduled_end TIMESTAMPTZ,
  auto_start BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'started', 'cancelled', 'failed', 'completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS scheduled_lives_start_idx ON scheduled_lives(status, scheduled_start);

CREATE TABLE IF NOT EXISTS session_logs (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS session_logs_session_idx ON session_logs(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS notifications_owner_idx ON notifications(user_id, created_at DESC);
