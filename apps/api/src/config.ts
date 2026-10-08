import path from 'node:path';

const production = process.env.NODE_ENV === 'production';
const jwtSecret = process.env.JWT_SECRET || (production ? '' : 'maya-development-session-secret-only-for-local-use');
const encryptionSecret = process.env.CREDENTIAL_ENCRYPTION_KEY || (production ? '' : 'maya-development-encryption-secret-only-local');

if (production && (!jwtSecret || jwtSecret.length < 32 || jwtSecret.includes('local-only'))) {
  throw new Error('Set a unique JWT_SECRET of at least 32 characters before production startup.');
}
if (production && (!encryptionSecret || encryptionSecret.length < 24 || encryptionSecret.includes('local-only'))) {
  throw new Error('Set a unique CREDENTIAL_ENCRYPTION_KEY before production startup.');
}

export const config = {
  production,
  port: Number(process.env.PORT || 4000),
  appOrigin: process.env.APP_ORIGIN || 'http://localhost:5173',
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  demoMode: process.env.DEMO_MODE === undefined ? !production : process.env.DEMO_MODE === 'true',
  jwtSecret,
  encryptionSecret,
  databaseUrl: process.env.DATABASE_URL || '',
  redisUrl: process.env.REDIS_URL || '',
  storageDriver: process.env.STORAGE_DRIVER === 's3' ? 's3' as const : 'local' as const,
  dataDir: path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data')),
  maxUploadBytes: Math.max(1_000_000, Number(process.env.MAX_UPLOAD_BYTES || 5 * 1024 ** 3)),
  ffmpegBin: process.env.FFMPEG_BIN || 'ffmpeg',
  ffprobeBin: process.env.FFPROBE_BIN || 'ffprobe',
  demoEmail: (process.env.DEMO_EMAIL || 'demo@mayastream.local').toLowerCase(),
  demoPassword: process.env.DEMO_PASSWORD || 'MayaDemo!2026',
  bootstrapAdminEmail: (process.env.BOOTSTRAP_ADMIN_EMAIL || '').toLowerCase(),
  bootstrapAdminPassword: process.env.BOOTSTRAP_ADMIN_PASSWORD || '',
  bootstrapAdminName: process.env.BOOTSTRAP_ADMIN_NAME || 'Workspace Admin',
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  googleRedirectUri: process.env.GOOGLE_REDIRECT_URI || 'http://localhost:4000/api/youtube/callback',
  workerConcurrency: Math.max(1, Number(process.env.WORKER_CONCURRENCY || 2)),
  maxReconnectAttempts: Math.max(0, Number(process.env.MAX_RECONNECT_ATTEMPTS || 6)),
  s3: {
    endpoint: process.env.S3_ENDPOINT || undefined,
    region: process.env.S3_REGION || 'us-east-1',
    bucket: process.env.S3_BUCKET || 'maya-streams',
    accessKey: process.env.S3_ACCESS_KEY || '',
    secretKey: process.env.S3_SECRET_KEY || '',
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
  },
};
