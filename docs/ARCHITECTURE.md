# Maya Cloud Live — Architecture & implementation notes

## System boundary

Maya is a control plane for user-authorized, server-side video rebroadcasting. The mobile/web dashboard is not the encoder. The API accepts uploads and control requests; a separate worker reads private media, creates a normalized stream profile, and sends it to YouTube's RTMP/RTMPS ingest endpoint with FFmpeg.

```text
Android-installable PWA / Web dashboard
        │ same-origin HTTPS + HttpOnly session cookie
        ▼
Node.js / TypeScript REST API ───────── PostgreSQL
        │                                    ├─ users, roles
        │                                    ├─ videos, playlists, items
        │                                    ├─ encrypted RTMP destinations / OAuth tokens
        │                                    ├─ sessions, schedules, logs, notifications
        ├──────── Redis + BullMQ ───────── Streaming worker (FFmpeg)
        │                                    │
        └──────── S3-compatible object store ┘
                                             │ RTMP/RTMPS
                                             ▼
                                          YouTube Live
```

The included Docker Compose stack provides PostgreSQL, Redis, MinIO, API and worker. The dashboard is built as a mobile-responsive PWA and served by the API in the container. `npm run dev` runs the API and Vite dashboard separately for local UI development.

## Technology decisions

- **Node.js + TypeScript + Express REST:** one language for API and worker; validation at the HTTP boundary; no platform-specific Android encoder.
- **PostgreSQL:** relational ownership, playlist ordering, session history, schedule records, partial unique index preventing concurrent sessions for one user, and atomic worker claims.
- **Redis + BullMQ:** durable/delayed stream jobs and control-plane events. Scheduled jobs are persisted in Postgres and mirrored to Redis; the database remains the source of truth.
- **S3-compatible object storage:** source files and derived H.264/AAC profiles are private. Local filesystem storage is available for development.
- **FFmpeg/ffprobe worker:** probes uploads, preserves aspect ratio with scale-and-pad, normalizes to a stable 30 fps H.264/AAC profile, caches processed outputs, and streams from the server. It does not expose FFmpeg arguments to dashboard users.
- **Mobile:** installable web/PWA control panel works on Android browsers. No long-running mobile media task is used. A native APK can later use the same authenticated REST API.

## Data model

`database/schema.sql` is the canonical initial schema. It defines `users`, `videos`, `playlists`, `playlist_items`, `streaming_destinations`, `youtube_connections`, `live_sessions`, `scheduled_lives`, `session_logs`, and `notifications`. All user-owned queries are scoped by the authenticated user ID. Secrets are encrypted with AES-256-GCM using `CREDENTIAL_ENCRYPTION_KEY`; plaintext values are never returned by API read endpoints.

## API surface

All authenticated endpoints are under `/api`; JSON errors use `{ "error": "...", "code": "..." }`.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness and dependency mode (no secrets) |
| `POST` | `/api/auth/login` | Email/password login; sets HttpOnly session cookie |
| `GET` | `/api/auth/me` | Current user |
| `POST` | `/api/auth/logout` | Clears session |
| `GET/POST` | `/api/videos` | List and upload (multipart `file`, `title`, `description`, `liveType`) |
| `PATCH/DELETE` | `/api/videos/:id` | Edit metadata / delete owned video |
| `GET/POST` | `/api/playlists` | List / create playlist and ordered video membership |
| `DELETE` | `/api/playlists/:id` | Delete owned playlist |
| `GET/PUT` | `/api/destination` | Read safe destination metadata / save encrypted manual RTMP key |
| `POST` | `/api/destination/test` | Validate YouTube ingest URL format without exposing the key |
| `GET` | `/api/youtube/connect` | Start official OAuth consent flow |
| `GET` | `/api/youtube/callback` | Exchange OAuth code; persist encrypted server-side tokens |
| `GET/DELETE` | `/api/youtube/status` | Show connection metadata / disconnect |
| `GET/POST` | `/api/live` | Session history / start session |
| `GET` | `/api/live/current` | Current active session and health |
| `POST` | `/api/live/:id/stop` | Request safe worker shutdown |
| `POST` | `/api/live/:id/restart` | Request controlled worker restart |
| `GET/POST` | `/api/schedules` | List / schedule a session |
| `DELETE` | `/api/schedules/:id` | Cancel a pending schedule |
| `GET` | `/api/notifications` | In-app notification list |
| `GET` | `/api/admin/overview` | Admin-only users, sessions and storage summary |

Manual RTMP mode is intentionally restricted to YouTube-owned ingest hostnames to prevent an arbitrary RTMP URL becoming an SSRF/pivot primitive. A connection “test” validates settings; actual ingestion can only be verified by starting a stream.

## Worker lifecycle

1. API validates ownership/readiness, confirms exactly one source (video or playlist), resolves a configured destination, creates a session, and enqueues a unique job ID.
2. Worker atomically claims the session in PostgreSQL. A unique active-session index and the claim prevent duplicate workers for the same user/session.
3. Worker downloads source files to a private temporary directory, probes them, builds/caches the selected vertical/horizontal profile, and writes a private concat manifest.
4. FFmpeg sends H.264/AAC to the encrypted ingest URL. The worker records redacted logs, heartbeat/health, elapsed time and retry count.
5. A stop control event sends a graceful termination signal. Non-zero FFmpeg exits get bounded exponential-backoff reconnects; natural end with loop off marks the session ended. Temporary files are removed in `finally` blocks.
6. OAuth sessions create an event-specific broadcast and stream, bind them, wait for the ingest to become active before transitioning live, and mark the broadcast complete on stop. Manual RTMP mode uses a broadcast already configured by the channel owner in YouTube Studio.

The database session ID is the BullMQ job ID. Each user has a partial unique index allowing only one active or scheduled session at a time. This is deliberate: channel concurrency limits are controlled by YouTube and can be lower than the service limit.

## Authentication and secrets

Passwords use Node's built-in `scrypt` with a random per-password salt and timing-safe verification. Signed session tokens are HMAC-SHA256 JWTs in `HttpOnly`, `SameSite=Strict` cookies (Secure in HTTPS deployments). API writes are rate-limited, security headers are enabled, file uploads have a configured byte limit, and Zod validates user-controlled fields. Role checks protect the admin route. `CREDENTIAL_ENCRYPTION_KEY`, `JWT_SECRET`, Google OAuth secrets, DB passwords, and storage credentials are environment-only; set strong unique values and terminate TLS at a trusted proxy in production.

## YouTube API limitations

- YouTube Live Streaming API manages broadcast/stream resources; it does not ingest the uploaded file. FFmpeg must send the media to the stream's RTMP/RTMPS ingest address.
- The API requires OAuth consent and a channel with live streaming enabled. A `liveBroadcasts.transition` to `testing` or `live` requires the bound stream to report `active`; channel restrictions, permissions, concurrency and daily limits remain YouTube-controlled.
- Live methods consume YouTube Data API quota. Google currently documents a default shared allowance of 10,000 units/day for other endpoints and lists live resource methods at 1 quota unit/call. Invalid calls also cost at least one unit. Monitor the Google Cloud project quota and back off on quota/rate-limit responses.
- 24/7 mode is best-effort, not an availability promise. Worker/container, cloud bandwidth, storage and YouTube can all interrupt a stream. Reconnect is bounded and observable; it does not bypass channel limits or platform enforcement.
- This app does not automate browser login, create viewers, manipulate engagement, upload to YouTube, or evade restrictions. Users must have streaming rights for their media.

Official references: [Live Streaming API](https://developers.google.com/youtube/v3/live/docs), [transition requirements/errors](https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/transition), [quota cost table](https://developers.google.com/youtube/v3/determine_quota_cost), [live streaming restrictions](https://support.google.com/youtube/answer/2853834).

## Folder map

```text
apps/api/src/            Express routes, auth, repository, storage, YouTube OAuth
apps/worker/src/         BullMQ consumer, FFmpeg lifecycle and reconnect
apps/web/src/            React/Vite responsive installable control panel
packages/core/src/       Shared domain types, validation, crypto, stream profile helpers
 database/schema.sql     PostgreSQL schema
 docs/ARCHITECTURE.md    System design and API contract
 docker-compose.yml      Local production-shaped services
```
