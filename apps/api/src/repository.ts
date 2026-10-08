import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool, type PoolClient } from 'pg';
import type {
  DestinationRecord,
  LiveSessionRecord,
  NotificationRecord,
  PlaylistRecord,
  ScheduleRecord,
  SessionCreateInput,
  SessionLogRecord,
  UserRecord,
  VideoRecord,
  YoutubeConnectionRecord,
} from '../../../packages/core/src/domain';
import { hashPassword } from '../../../packages/core/src/security';
import { config } from './config';

function asIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return value ? new Date(String(value)).toISOString() : new Date().toISOString();
}

function mapUser(row: Record<string, unknown>): UserRecord {
  return {
    id: String(row.id), email: String(row.email), name: String(row.name),
    passwordHash: String(row.password_hash), role: row.role === 'admin' ? 'admin' : 'user',
    disabled: Boolean(row.disabled), createdAt: asIso(row.created_at),
  };
}

function mapVideo(row: Record<string, unknown>): VideoRecord {
  return {
    id: String(row.id), userId: String(row.user_id), title: String(row.title),
    description: String(row.description || ''), objectKey: String(row.object_key),
    thumbnailKey: row.thumbnail_key ? String(row.thumbnail_key) : null,
    originalName: String(row.original_name || ''), mimeType: String(row.mime_type || 'video/mp4'),
    sizeBytes: Number(row.size_bytes || 0), durationSeconds: Number(row.duration_seconds || 0),
    width: Number(row.width || 0), height: Number(row.height || 0), fps: Number(row.fps || 0),
    videoCodec: row.video_codec ? String(row.video_codec) : null,
    audioCodec: row.audio_codec ? String(row.audio_codec) : null,
    liveType: row.live_type === 'vertical' ? 'vertical' : 'horizontal',
    loopEnabled: Boolean(row.loop_enabled),
    status: row.status === 'failed' || row.status === 'processing' ? row.status : 'ready',
    errorMessage: row.error_message ? String(row.error_message) : null,
    createdAt: asIso(row.created_at), updatedAt: asIso(row.updated_at),
  };
}

function mapDestination(row: Record<string, unknown>): DestinationRecord {
  return {
    id: String(row.id), userId: String(row.user_id),
    mode: row.mode === 'youtube_api' ? 'youtube_api' : 'manual', platform: 'youtube',
    serverUrl: row.server_url ? String(row.server_url) : null,
    encryptedStreamKey: row.encrypted_stream_key ? String(row.encrypted_stream_key) : null,
    keyFingerprint: row.key_fingerprint ? String(row.key_fingerprint) : null,
    createdAt: asIso(row.created_at), updatedAt: asIso(row.updated_at),
  };
}

function mapConnection(row: Record<string, unknown>): YoutubeConnectionRecord {
  return {
    userId: String(row.user_id), channelId: String(row.channel_id), channelTitle: String(row.channel_title),
    encryptedAccessToken: String(row.encrypted_access_token), encryptedRefreshToken: String(row.encrypted_refresh_token),
    expiresAt: asIso(row.expires_at), createdAt: asIso(row.created_at), updatedAt: asIso(row.updated_at),
  };
}

function mapSession(row: Record<string, unknown>): LiveSessionRecord {
  return {
    id: String(row.id), userId: String(row.user_id), destinationId: row.destination_id ? String(row.destination_id) : null,
    videoId: row.video_id ? String(row.video_id) : null, playlistId: row.playlist_id ? String(row.playlist_id) : null,
    liveType: row.live_type === 'vertical' ? 'vertical' : 'horizontal',
    status: String(row.status) as LiveSessionRecord['status'], loopEnabled: Boolean(row.loop_enabled),
    skipFailedVideos: Boolean(row.skip_failed_videos),
    currentVideoId: row.current_video_id ? String(row.current_video_id) : null,
    encryptedIngestUrl: row.encrypted_ingest_url ? String(row.encrypted_ingest_url) : null,
    youtubeBroadcastId: row.youtube_broadcast_id ? String(row.youtube_broadcast_id) : null,
    youtubeStreamId: row.youtube_stream_id ? String(row.youtube_stream_id) : null,
    workerId: row.worker_id ? String(row.worker_id) : null,
    healthStatus: String(row.health_status || 'unknown') as LiveSessionRecord['healthStatus'],
    bitrateKbps: row.bitrate_kbps === null || row.bitrate_kbps === undefined ? null : Number(row.bitrate_kbps),
    fps: row.fps === null || row.fps === undefined ? null : Number(row.fps),
    droppedFrames: row.dropped_frames === null || row.dropped_frames === undefined ? null : Number(row.dropped_frames),
    reconnectAttempts: Number(row.reconnect_attempts || 0),
    startedAt: row.started_at ? asIso(row.started_at) : null, endedAt: row.ended_at ? asIso(row.ended_at) : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
    createdAt: asIso(row.created_at), updatedAt: asIso(row.updated_at),
  };
}

function mapSchedule(row: Record<string, unknown>): ScheduleRecord {
  return {
    id: String(row.id), userId: String(row.user_id), sessionId: String(row.session_id),
    scheduledStart: asIso(row.scheduled_start), scheduledEnd: row.scheduled_end ? asIso(row.scheduled_end) : null,
    autoStart: Boolean(row.auto_start), status: String(row.status) as ScheduleRecord['status'], createdAt: asIso(row.created_at),
  };
}

function mapNotification(row: Record<string, unknown>): NotificationRecord {
  return {
    id: String(row.id), userId: String(row.user_id), type: String(row.type), title: String(row.title),
    message: String(row.message), readAt: row.read_at ? asIso(row.read_at) : null, createdAt: asIso(row.created_at),
  };
}

const demoVideoSpecs = [
  { title: 'Cat Adventure #01', description: 'A calm, vertical short-form story.', duration: 633, width: 1080, height: 1920, fps: 30, size: 481_000_000, liveType: 'vertical' as const, color: 'violet' },
  { title: 'Morning Ritual — Lo-fi Mix', description: 'Ambient desk and study session.', duration: 1824, width: 1920, height: 1080, fps: 30, size: 1_270_000_000, liveType: 'horizontal' as const, color: 'orange' },
  { title: 'Ocean Window Loop', description: 'Soft waves for a quiet space.', duration: 908, width: 1920, height: 1080, fps: 25, size: 755_000_000, liveType: 'horizontal' as const, color: 'blue' },
  { title: 'City Rain — Vertical', description: 'Rainy streets in a portrait frame.', duration: 452, width: 1080, height: 1920, fps: 30, size: 366_000_000, liveType: 'vertical' as const, color: 'green' },
];

export class Repository {
  readonly persistent: boolean;
  private readonly pool: Pool | null;
  private readonly users = new Map<string, UserRecord>();
  private readonly videos = new Map<string, VideoRecord>();
  private readonly playlists = new Map<string, PlaylistRecord>();
  private readonly destinations = new Map<string, DestinationRecord>();
  private readonly connections = new Map<string, YoutubeConnectionRecord>();
  private readonly sessions = new Map<string, LiveSessionRecord>();
  private readonly schedules = new Map<string, ScheduleRecord>();
  private readonly logs: SessionLogRecord[] = [];
  private readonly notifications: NotificationRecord[] = [];

  constructor() {
    this.persistent = Boolean(config.databaseUrl);
    this.pool = config.databaseUrl
      ? new Pool({ connectionString: config.databaseUrl, max: 12, idleTimeoutMillis: 30_000 })
      : null;
  }

  async init(): Promise<void> {
    if (this.pool) {
      const schemaPath = path.resolve(process.cwd(), 'database/schema.sql');
      const schema = await readFile(schemaPath, 'utf8');
      await this.pool.query(schema);
    }
    if (config.demoMode) await this.ensureDemoAccount();
    else await this.ensureBootstrapAdmin();
  }

  private async ensureBootstrapAdmin(): Promise<void> {
    const email = config.bootstrapAdminEmail;
    const password = config.bootstrapAdminPassword;
    if (!email && !password) return;
    if (!email || !email.includes('@') || password.length < 12) {
      throw new Error('Set a valid BOOTSTRAP_ADMIN_EMAIL and a BOOTSTRAP_ADMIN_PASSWORD of at least 12 characters.');
    }
    if (await this.getUserByEmail(email)) return;
    await this.createUser({
      id: randomUUID(), email, name: config.bootstrapAdminName.slice(0, 100),
      passwordHash: hashPassword(password), role: 'admin', disabled: false, createdAt: new Date().toISOString(),
    });
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }

  private async ensureDemoAccount(): Promise<UserRecord> {
    const existing = await this.getUserByEmail(config.demoEmail);
    const user: UserRecord = existing || await this.createUser({
      id: randomUUID(), email: config.demoEmail, name: 'Maya Demo',
      passwordHash: hashPassword(config.demoPassword), role: 'admin', disabled: false,
      createdAt: new Date().toISOString(),
    });
    if ((await this.listVideos(user.id)).length === 0) {
      for (const [index, spec] of demoVideoSpecs.entries()) {
        const now = new Date(Date.now() - index * 86_400_000).toISOString();
        const video: VideoRecord = {
          id: randomUUID(), userId: user.id, title: spec.title, description: spec.description,
          objectKey: `preview/${user.id}/${index}.mp4`, thumbnailKey: null, originalName: `${spec.title}.mp4`,
          mimeType: 'video/mp4', sizeBytes: spec.size, durationSeconds: spec.duration, width: spec.width,
          height: spec.height, fps: spec.fps, videoCodec: 'h264', audioCodec: 'aac', liveType: spec.liveType,
          loopEnabled: false, status: 'ready', errorMessage: null, createdAt: now, updatedAt: now,
        };
        await this.createVideo(video);
      }
    }
    const allVideos = await this.listVideos(user.id);
    if (allVideos.length >= 2 && (await this.listPlaylists(user.id)).length === 0) {
      await this.createPlaylist({
        id: randomUUID(), userId: user.id, name: 'Night ambience rotation', loopEnabled: true,
        items: allVideos.slice(1, 3).map((video, position) => ({ videoId: video.id, position })),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
    }
    return user;
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    if (this.pool) {
      const result = await this.pool.query('SELECT * FROM users WHERE email = $1 LIMIT 1', [email.toLowerCase()]);
      return result.rows[0] ? mapUser(result.rows[0]) : null;
    }
    return [...this.users.values()].find((user) => user.email === email.toLowerCase()) || null;
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    if (this.pool) {
      const result = await this.pool.query('SELECT * FROM users WHERE id = $1 LIMIT 1', [id]);
      return result.rows[0] ? mapUser(result.rows[0]) : null;
    }
    return this.users.get(id) || null;
  }

  async createUser(user: UserRecord): Promise<UserRecord> {
    if (this.pool) {
      const result = await this.pool.query(
        `INSERT INTO users (id,email,name,password_hash,role,disabled,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (email) DO NOTHING RETURNING *`,
        [user.id, user.email.toLowerCase(), user.name, user.passwordHash, user.role, user.disabled, user.createdAt],
      );
      if (result.rows[0]) return mapUser(result.rows[0]);
      const existing = await this.getUserByEmail(user.email);
      if (existing) return existing;
      throw new Error('Could not create user.');
    }
    this.users.set(user.id, { ...user, email: user.email.toLowerCase() });
    return user;
  }

  async listUsers(): Promise<UserRecord[]> {
    if (this.pool) {
      const result = await this.pool.query('SELECT * FROM users ORDER BY created_at DESC LIMIT 500');
      return result.rows.map(mapUser);
    }
    return [...this.users.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async setUserDisabled(id: string, disabled: boolean): Promise<void> {
    if (this.pool) {
      await this.pool.query('UPDATE users SET disabled=$2 WHERE id=$1', [id, disabled]);
      return;
    }
    const user = this.users.get(id);
    if (user) this.users.set(id, { ...user, disabled });
  }

  async listVideos(userId: string): Promise<VideoRecord[]> {
    if (this.pool) {
      const result = await this.pool.query('SELECT * FROM videos WHERE user_id=$1 ORDER BY created_at DESC', [userId]);
      return result.rows.map(mapVideo);
    }
    return [...this.videos.values()].filter((video) => video.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getVideo(userId: string, id: string): Promise<VideoRecord | null> {
    if (this.pool) {
      const result = await this.pool.query('SELECT * FROM videos WHERE user_id=$1 AND id=$2 LIMIT 1', [userId, id]);
      return result.rows[0] ? mapVideo(result.rows[0]) : null;
    }
    const video = this.videos.get(id);
    return video?.userId === userId ? video : null;
  }

  async createVideo(video: VideoRecord): Promise<VideoRecord> {
    if (this.pool) {
      const result = await this.pool.query(
        `INSERT INTO videos (id,user_id,title,description,object_key,thumbnail_key,original_name,mime_type,size_bytes,
          duration_seconds,width,height,fps,video_codec,audio_codec,live_type,loop_enabled,status,error_message,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
        [video.id, video.userId, video.title, video.description, video.objectKey, video.thumbnailKey, video.originalName,
          video.mimeType, video.sizeBytes, video.durationSeconds, video.width, video.height, video.fps, video.videoCodec,
          video.audioCodec, video.liveType, video.loopEnabled, video.status, video.errorMessage, video.createdAt, video.updatedAt],
      );
      return mapVideo(result.rows[0]);
    }
    this.videos.set(video.id, video);
    return video;
  }

  async updateVideo(userId: string, id: string, patch: Partial<Pick<VideoRecord, 'title' | 'description' | 'liveType' | 'loopEnabled' | 'status' | 'errorMessage'>>): Promise<VideoRecord | null> {
    if (this.pool) {
      const columns: Record<string, string> = { title: 'title', description: 'description', liveType: 'live_type', loopEnabled: 'loop_enabled', status: 'status', errorMessage: 'error_message' };
      const values: unknown[] = [id, userId];
      const sets: string[] = [];
      for (const [key, value] of Object.entries(patch)) {
        const column = columns[key];
        if (!column) continue;
        values.push(value);
        sets.push(`${column}=$${values.length}`);
      }
      if (!sets.length) return this.getVideo(userId, id);
      const result = await this.pool.query(
        `UPDATE videos SET ${sets.join(',')}, updated_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING *`, values,
      );
      return result.rows[0] ? mapVideo(result.rows[0]) : null;
    }
    const video = await this.getVideo(userId, id);
    if (!video) return null;
    const updated = { ...video, ...patch, updatedAt: new Date().toISOString() };
    this.videos.set(id, updated);
    return updated;
  }

  async deleteVideo(userId: string, id: string): Promise<VideoRecord | null> {
    if (this.pool) {
      const result = await this.pool.query('DELETE FROM videos WHERE user_id=$1 AND id=$2 RETURNING *', [userId, id]);
      return result.rows[0] ? mapVideo(result.rows[0]) : null;
    }
    const video = await this.getVideo(userId, id);
    if (video) this.videos.delete(id);
    return video;
  }

  async listPlaylists(userId: string): Promise<PlaylistRecord[]> {
    if (this.pool) {
      const result = await this.pool.query(
        `SELECT p.*, COALESCE(json_agg(json_build_object('videoId',pi.video_id,'position',pi.position)
          ORDER BY pi.position) FILTER (WHERE pi.video_id IS NOT NULL), '[]') AS items
         FROM playlists p LEFT JOIN playlist_items pi ON pi.playlist_id=p.id
         WHERE p.user_id=$1 GROUP BY p.id ORDER BY p.created_at DESC`, [userId],
      );
      return result.rows.map((row) => ({
        id: String(row.id), userId: String(row.user_id), name: String(row.name), loopEnabled: Boolean(row.loop_enabled),
        items: (row.items as Array<{ videoId: string; position: number }>).map((item) => ({ videoId: String(item.videoId), position: Number(item.position) })),
        createdAt: asIso(row.created_at), updatedAt: asIso(row.updated_at),
      }));
    }
    return [...this.playlists.values()].filter((playlist) => playlist.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getPlaylist(userId: string, id: string): Promise<PlaylistRecord | null> {
    if (this.pool) return (await this.listPlaylists(userId)).find((playlist) => playlist.id === id) || null;
    const playlist = this.playlists.get(id);
    return playlist?.userId === userId ? playlist : null;
  }

  async createPlaylist(playlist: PlaylistRecord): Promise<PlaylistRecord> {
    if (this.pool) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO playlists (id,user_id,name,loop_enabled,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6)`,
          [playlist.id, playlist.userId, playlist.name, playlist.loopEnabled, playlist.createdAt, playlist.updatedAt],
        );
        for (const item of playlist.items) {
          await client.query('INSERT INTO playlist_items (playlist_id,video_id,position) VALUES ($1,$2,$3)', [playlist.id, item.videoId, item.position]);
        }
        await client.query('COMMIT');
        return playlist;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    this.playlists.set(playlist.id, playlist);
    return playlist;
  }

  async addPlaylistVideos(userId: string, playlistId: string, videoIds: string[]): Promise<PlaylistRecord | null> {
    if (this.pool) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const owner = await client.query('SELECT id FROM playlists WHERE id=$1 AND user_id=$2 FOR UPDATE', [playlistId, userId]);
        if (!owner.rows[0]) { await client.query('ROLLBACK'); return null; }
        const positionResult = await client.query('SELECT COALESCE(MAX(position),-1)::int AS position FROM playlist_items WHERE playlist_id=$1', [playlistId]);
        let position = Number(positionResult.rows[0].position) + 1;
        for (const videoId of videoIds) {
          const inserted = await client.query(
            'INSERT INTO playlist_items (playlist_id,video_id,position) VALUES ($1,$2,$3) ON CONFLICT (playlist_id,video_id) DO NOTHING RETURNING video_id',
            [playlistId, videoId, position],
          );
          if (inserted.rowCount) position += 1;
        }
        await client.query('UPDATE playlists SET updated_at=NOW() WHERE id=$1', [playlistId]);
        await client.query('COMMIT');
        return this.getPlaylist(userId, playlistId);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    const playlist = await this.getPlaylist(userId, playlistId);
    if (!playlist) return null;
    const items = [...playlist.items];
    let position = items.reduce((max, item) => Math.max(max, item.position), -1) + 1;
    for (const videoId of videoIds) {
      if (!items.some((item) => item.videoId === videoId)) items.push({ videoId, position: position++ });
    }
    const updated = { ...playlist, items, updatedAt: new Date().toISOString() };
    this.playlists.set(playlistId, updated);
    return updated;
  }

  async deletePlaylist(userId: string, id: string): Promise<boolean> {
    if (this.pool) {
      const result = await this.pool.query('DELETE FROM playlists WHERE user_id=$1 AND id=$2', [userId, id]);
      return (result.rowCount || 0) > 0;
    }
    const playlist = await this.getPlaylist(userId, id);
    if (!playlist) return false;
    this.playlists.delete(id);
    return true;
  }

  async getDestination(userId: string): Promise<DestinationRecord | null> {
    if (this.pool) {
      const result = await this.pool.query('SELECT * FROM streaming_destinations WHERE user_id=$1 LIMIT 1', [userId]);
      return result.rows[0] ? mapDestination(result.rows[0]) : null;
    }
    return this.destinations.get(userId) || null;
  }

  async saveDestination(destination: DestinationRecord): Promise<DestinationRecord> {
    if (this.pool) {
      const result = await this.pool.query(
        `INSERT INTO streaming_destinations (id,user_id,mode,platform,server_url,encrypted_stream_key,key_fingerprint,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (user_id) DO UPDATE SET mode=EXCLUDED.mode, platform=EXCLUDED.platform, server_url=EXCLUDED.server_url,
           encrypted_stream_key=EXCLUDED.encrypted_stream_key, key_fingerprint=EXCLUDED.key_fingerprint, updated_at=NOW()
         RETURNING *`,
        [destination.id, destination.userId, destination.mode, destination.platform, destination.serverUrl,
          destination.encryptedStreamKey, destination.keyFingerprint, destination.createdAt, destination.updatedAt],
      );
      return mapDestination(result.rows[0]);
    }
    const existing = this.destinations.get(destination.userId);
    const saved = existing ? { ...destination, id: existing.id, createdAt: existing.createdAt } : destination;
    this.destinations.set(destination.userId, saved);
    return saved;
  }

  async getYoutubeConnection(userId: string): Promise<YoutubeConnectionRecord | null> {
    if (this.pool) {
      const result = await this.pool.query('SELECT * FROM youtube_connections WHERE user_id=$1 LIMIT 1', [userId]);
      return result.rows[0] ? mapConnection(result.rows[0]) : null;
    }
    return this.connections.get(userId) || null;
  }

  async saveYoutubeConnection(connection: YoutubeConnectionRecord): Promise<void> {
    if (this.pool) {
      await this.pool.query(
        `INSERT INTO youtube_connections (user_id,channel_id,channel_title,encrypted_access_token,encrypted_refresh_token,expires_at,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (user_id) DO UPDATE SET channel_id=EXCLUDED.channel_id, channel_title=EXCLUDED.channel_title,
           encrypted_access_token=EXCLUDED.encrypted_access_token, encrypted_refresh_token=EXCLUDED.encrypted_refresh_token,
           expires_at=EXCLUDED.expires_at, updated_at=NOW()`,
        [connection.userId, connection.channelId, connection.channelTitle, connection.encryptedAccessToken,
          connection.encryptedRefreshToken, connection.expiresAt, connection.createdAt, connection.updatedAt],
      );
      return;
    }
    this.connections.set(connection.userId, connection);
  }

  async deleteYoutubeConnection(userId: string): Promise<void> {
    if (this.pool) {
      await this.pool.query('DELETE FROM youtube_connections WHERE user_id=$1', [userId]);
      return;
    }
    this.connections.delete(userId);
  }

  async createSession(input: SessionCreateInput): Promise<LiveSessionRecord> {
    const now = new Date().toISOString();
    const session: LiveSessionRecord = {
      id: input.id || randomUUID(), userId: input.userId, destinationId: input.destinationId,
      videoId: input.videoId, playlistId: input.playlistId, liveType: input.liveType, status: input.status,
      loopEnabled: input.loopEnabled, skipFailedVideos: input.skipFailedVideos || false,
      currentVideoId: input.currentVideoId || input.videoId,
      encryptedIngestUrl: input.encryptedIngestUrl, youtubeBroadcastId: input.youtubeBroadcastId || null,
      youtubeStreamId: input.youtubeStreamId || null, workerId: null, healthStatus: 'unknown',
      bitrateKbps: null, fps: null, droppedFrames: null, reconnectAttempts: 0, startedAt: null, endedAt: null,
      errorMessage: null, createdAt: now, updatedAt: now,
    };
    if (this.pool) {
      const result = await this.pool.query(
        `INSERT INTO live_sessions (id,user_id,destination_id,video_id,playlist_id,live_type,status,loop_enabled,current_video_id,
          encrypted_ingest_url,youtube_broadcast_id,youtube_stream_id,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) RETURNING *`,
        [session.id, session.userId, session.destinationId, session.videoId, session.playlistId, session.liveType,
          session.status, session.loopEnabled, session.currentVideoId, session.encryptedIngestUrl,
          session.youtubeBroadcastId, session.youtubeStreamId, now],
      );
      return mapSession(result.rows[0]);
    }
    this.sessions.set(session.id, session);
    return session;
  }

  async getSession(id: string): Promise<LiveSessionRecord | null> {
    if (this.pool) {
      const result = await this.pool.query('SELECT * FROM live_sessions WHERE id=$1 LIMIT 1', [id]);
      return result.rows[0] ? mapSession(result.rows[0]) : null;
    }
    return this.sessions.get(id) || null;
  }

  async getSessionForUser(userId: string, id: string): Promise<LiveSessionRecord | null> {
    if (this.pool) {
      const result = await this.pool.query('SELECT * FROM live_sessions WHERE user_id=$1 AND id=$2 LIMIT 1', [userId, id]);
      return result.rows[0] ? mapSession(result.rows[0]) : null;
    }
    const session = this.sessions.get(id);
    return session?.userId === userId ? session : null;
  }

  async getActiveSession(userId: string): Promise<LiveSessionRecord | null> {
    if (this.pool) {
      const result = await this.pool.query(
        `SELECT * FROM live_sessions WHERE user_id=$1 AND status IN ('scheduled','queued','starting','live','reconnecting','stopping')
         ORDER BY created_at DESC LIMIT 1`, [userId],
      );
      return result.rows[0] ? mapSession(result.rows[0]) : null;
    }
    return [...this.sessions.values()].find((session) => session.userId === userId &&
      ['scheduled', 'queued', 'starting', 'live', 'reconnecting', 'stopping'].includes(session.status)) || null;
  }

  async listSessions(userId?: string): Promise<LiveSessionRecord[]> {
    if (this.pool) {
      const result = userId
        ? await this.pool.query('SELECT * FROM live_sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200', [userId])
        : await this.pool.query('SELECT * FROM live_sessions ORDER BY created_at DESC LIMIT 500');
      return result.rows.map(mapSession);
    }
    return [...this.sessions.values()].filter((session) => !userId || session.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async updateSession(id: string, patch: Partial<LiveSessionRecord>): Promise<LiveSessionRecord | null> {
    if (this.pool) {
      const columns: Record<string, string> = {
        destinationId: 'destination_id', videoId: 'video_id', playlistId: 'playlist_id', liveType: 'live_type',
        status: 'status', loopEnabled: 'loop_enabled', skipFailedVideos: 'skip_failed_videos', currentVideoId: 'current_video_id',
        encryptedIngestUrl: 'encrypted_ingest_url', youtubeBroadcastId: 'youtube_broadcast_id', youtubeStreamId: 'youtube_stream_id',
        workerId: 'worker_id', healthStatus: 'health_status', bitrateKbps: 'bitrate_kbps', fps: 'fps', droppedFrames: 'dropped_frames',
        reconnectAttempts: 'reconnect_attempts', startedAt: 'started_at', endedAt: 'ended_at', errorMessage: 'error_message',
      };
      const values: unknown[] = [id];
      const sets: string[] = [];
      for (const [key, value] of Object.entries(patch)) {
        const column = columns[key];
        if (!column) continue;
        values.push(value);
        sets.push(`${column}=$${values.length}`);
      }
      if (!sets.length) return this.getSession(id);
      const result = await this.pool.query(
        `UPDATE live_sessions SET ${sets.join(',')}, updated_at=NOW() WHERE id=$1 RETURNING *`, values,
      );
      return result.rows[0] ? mapSession(result.rows[0]) : null;
    }
    const session = this.sessions.get(id);
    if (!session) return null;
    const updated = { ...session, ...patch, updatedAt: new Date().toISOString() };
    this.sessions.set(id, updated);
    return updated;
  }

  async claimSession(id: string, workerId: string): Promise<LiveSessionRecord | null> {
    if (this.pool) {
      const result = await this.pool.query(
        `UPDATE live_sessions SET status='starting', worker_id=$2, health_status='warning', error_message=NULL, updated_at=NOW()
         WHERE id=$1 AND status IN ('scheduled','queued','reconnecting','starting','live')
           AND (worker_id IS NULL OR worker_id=$2 OR updated_at < NOW() - INTERVAL '90 seconds')
         RETURNING *`, [id, workerId],
      );
      return result.rows[0] ? mapSession(result.rows[0]) : null;
    }
    const session = this.sessions.get(id);
    if (!session || !['scheduled', 'queued', 'reconnecting', 'starting', 'live'].includes(session.status) ||
      (session.workerId && session.workerId !== workerId && Date.parse(session.updatedAt) > Date.now() - 90_000)) return null;
    const claimed = { ...session, status: 'starting' as const, workerId, healthStatus: 'warning' as const, errorMessage: null, updatedAt: new Date().toISOString() };
    this.sessions.set(id, claimed);
    return claimed;
  }

  async createSchedule(schedule: ScheduleRecord): Promise<ScheduleRecord> {
    if (this.pool) {
      const result = await this.pool.query(
        `INSERT INTO scheduled_lives (id,user_id,session_id,scheduled_start,scheduled_end,auto_start,status,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [schedule.id, schedule.userId, schedule.sessionId, schedule.scheduledStart, schedule.scheduledEnd,
          schedule.autoStart, schedule.status, schedule.createdAt],
      );
      return mapSchedule(result.rows[0]);
    }
    this.schedules.set(schedule.id, schedule);
    return schedule;
  }

  async listSchedules(userId?: string): Promise<ScheduleRecord[]> {
    if (this.pool) {
      const result = userId
        ? await this.pool.query('SELECT * FROM scheduled_lives WHERE user_id=$1 ORDER BY scheduled_start', [userId])
        : await this.pool.query('SELECT * FROM scheduled_lives ORDER BY scheduled_start');
      return result.rows.map(mapSchedule);
    }
    return [...this.schedules.values()].filter((schedule) => !userId || schedule.userId === userId)
      .sort((a, b) => a.scheduledStart.localeCompare(b.scheduledStart));
  }

  async getScheduleForUser(userId: string, id: string): Promise<ScheduleRecord | null> {
    if (this.pool) {
      const result = await this.pool.query('SELECT * FROM scheduled_lives WHERE user_id=$1 AND id=$2 LIMIT 1', [userId, id]);
      return result.rows[0] ? mapSchedule(result.rows[0]) : null;
    }
    const schedule = this.schedules.get(id);
    return schedule?.userId === userId ? schedule : null;
  }

  async updateSchedule(id: string, status: ScheduleRecord['status']): Promise<void> {
    if (this.pool) {
      await this.pool.query('UPDATE scheduled_lives SET status=$2 WHERE id=$1', [id, status]);
      return;
    }
    const schedule = this.schedules.get(id);
    if (schedule) this.schedules.set(id, { ...schedule, status });
  }

  async appendLog(sessionId: string, level: SessionLogRecord['level'], message: string): Promise<void> {
    const safeMessage = message.slice(0, 1000);
    if (this.pool) {
      await this.pool.query('INSERT INTO session_logs (session_id,level,message) VALUES ($1,$2,$3)', [sessionId, level, safeMessage]);
      return;
    }
    this.logs.push({ id: this.logs.length + 1, sessionId, level, message: safeMessage, createdAt: new Date().toISOString() });
  }

  async listLogs(sessionId: string, limit = 100): Promise<SessionLogRecord[]> {
    if (this.pool) {
      const result = await this.pool.query(
        'SELECT * FROM session_logs WHERE session_id=$1 ORDER BY created_at DESC LIMIT $2', [sessionId, Math.min(500, limit)],
      );
      return result.rows.map((row) => ({
        id: Number(row.id), sessionId: String(row.session_id), level: row.level as SessionLogRecord['level'],
        message: String(row.message), createdAt: asIso(row.created_at),
      }));
    }
    return this.logs.filter((log) => log.sessionId === sessionId).slice(-limit).reverse();
  }

  async createNotification(userId: string, type: string, title: string, message: string): Promise<void> {
    if (this.pool) {
      await this.pool.query('INSERT INTO notifications (user_id,type,title,message) VALUES ($1,$2,$3,$4)', [userId, type, title, message]);
      return;
    }
    this.notifications.unshift({ id: randomUUID(), userId, type, title, message, readAt: null, createdAt: new Date().toISOString() });
  }

  async listNotifications(userId: string): Promise<NotificationRecord[]> {
    if (this.pool) {
      const result = await this.pool.query('SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [userId]);
      return result.rows.map(mapNotification);
    }
    return this.notifications.filter((item) => item.userId === userId).slice(0, 100);
  }

  async markNotificationsRead(userId: string): Promise<void> {
    if (this.pool) {
      await this.pool.query('UPDATE notifications SET read_at=NOW() WHERE user_id=$1 AND read_at IS NULL', [userId]);
      return;
    }
    for (let index = 0; index < this.notifications.length; index += 1) {
      const item = this.notifications[index];
      if (item.userId === userId && !item.readAt) this.notifications[index] = { ...item, readAt: new Date().toISOString() };
    }
  }

  async getAdminSummary(): Promise<{ users: number; videos: number; storageBytes: number; sessions: LiveSessionRecord[] }> {
    if (this.pool) {
      const result = await this.pool.query(
        `SELECT (SELECT COUNT(*) FROM users)::int AS users, (SELECT COUNT(*) FROM videos)::int AS videos,
          COALESCE((SELECT SUM(size_bytes) FROM videos),0)::bigint AS storage_bytes`,
      );
      return {
        users: Number(result.rows[0].users), videos: Number(result.rows[0].videos), storageBytes: Number(result.rows[0].storage_bytes),
        sessions: await this.listSessions(),
      };
    }
    const videos = [...this.videos.values()];
    return {
      users: this.users.size, videos: videos.length,
      storageBytes: videos.reduce((sum, video) => sum + video.sizeBytes, 0), sessions: await this.listSessions(),
    };
  }

  async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!this.pool) throw new Error('Database transaction is not available in preview storage mode.');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
