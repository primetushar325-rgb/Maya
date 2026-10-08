# Maya Cloud Live

A server-side **video → FFmpeg → RTMP/RTMPS → YouTube Live** control panel. The dashboard is a responsive, Android-installable PWA; the server and worker own uploads, scheduling, stream lifecycle and encoding, so a phone can disconnect without stopping a worker-owned stream.

> YouTube channel eligibility, API/OAuth approval, channel concurrency limits, network availability, and copyright rules still apply. The app never fabricates engagement or bypasses platform restrictions. See [YouTube/API limitations and architecture](docs/ARCHITECTURE.md).

## Quick start: UI/API preview

Requires Node.js 20.19+ (Node 22 recommended) and npm.

```bash
cp .env.example .env
npm install
npm run dev
```

Open the Vite URL shown in the terminal (normally `http://localhost:5173`). Demo login:

- Email: `demo@mayastream.local`
- Password: `MayaDemo!2026`

Without `DATABASE_URL` or `REDIS_URL`, the API uses an isolated in-memory preview store. This is **not** a real streaming deployment: start requests are refused unless persistent database, queue, storage, destination and worker dependencies are configured. The dashboard never labels a simulated session as a YouTube live stream.

Video inspection/encoding requires `ffprobe` and `ffmpeg`. Install them locally or use Docker Compose below. Demo catalog entries are illustrative metadata and do not contain actual video files.

## Full local stack

Requires Docker Compose. Copy `.env.example` to `.env`, replace the local-only secrets, then run:

```bash
docker compose up --build
```

Open `http://localhost:4000`. Before production, set unique random `JWT_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`, `POSTGRES_PASSWORD`, `S3_ACCESS_KEY`, and `S3_SECRET_KEY`; configure HTTPS and `COOKIE_SECURE=true`. The default compose credentials are for local development only. MinIO console is available on port 9001 if you choose to publish it; it is not exposed by default.

For a first persistent login, set `BOOTSTRAP_ADMIN_EMAIL` and a unique `BOOTSTRAP_ADMIN_PASSWORD` (at least 12 characters) in `.env`; the API creates that admin only if the email does not already exist. Remove the bootstrap password after the first start. Configure Google OAuth in Google Cloud Console (enable YouTube Data API v3, create a Web OAuth client, add your exact callback URL `/api/youtube/callback`, and provide the OAuth variables in `.env`) to use **Connect YouTube Account**. Or save a YouTube Studio RTMP/RTMPS server URL and stream key under YouTube settings. Manual mode sends only to YouTube ingest hostnames.

## Development commands

```bash
npm run dev           # API + Vite dashboard
npm run dev:worker    # optional worker; needs Postgres + Redis
npm run typecheck
npm test
npm run build         # typecheck + production dashboard bundle
```

Environment variables are documented in `.env.example`. The initial relational schema is `database/schema.sql`; API startup applies its idempotent DDL when `DATABASE_URL` is configured. Local filesystem storage is the default for the API preview. Docker Compose uses private S3-compatible MinIO storage.

## Current implementation boundary

The repository now contains the end-to-end control-plane foundation: authenticated dashboard, upload/library/playlist/destination/scheduling flows, PostgreSQL schema, encrypted credentials, OAuth/Live API client, Redis/BullMQ job lifecycle, FFmpeg worker and Docker deployment. A real broadcast requires a configured YouTube channel, secrets, persistent services, worker, FFmpeg, and user-owned content; no local preview can prove YouTube ingest without those external credentials and channel eligibility.
