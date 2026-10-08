import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createAuthRouter } from './auth';
import { createAdminRouter } from './admin';
import { config } from './config';
import { createLiveRouter } from './live';
import { createNotificationsRouter } from './notifications';
import { createPlaylistsRouter } from './playlists';
import { QueueService } from './queue';
import { Repository } from './repository';
import { createSchedulesRouter } from './schedules';
import { ObjectStorage } from './storage';
import { protectUnsafeOrigins } from './middleware';
import { createVideosRouter } from './videos';
import { createYoutubeRouter } from './youtube';

async function start(): Promise<void> {
  const repository = new Repository();
  const storage = new ObjectStorage();
  const queue = new QueueService();
  await repository.init();
  await storage.init();
  if (queue.configured) {
    await queue.waitUntilReady().catch((error) => console.warn('Redis is not ready yet:', error instanceof Error ? error.message : 'connection failed'));
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'same-site' },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'", 'https://accounts.google.com'],
      },
    },
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));
  app.use(protectUnsafeOrigins);

  const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 600,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many requests. Please wait a few minutes and try again.', code: 'rate_limited' },
  });
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many sign-in attempts. Please wait 15 minutes before trying again.', code: 'login_rate_limited' },
  });
  app.use('/api', generalLimiter);

  app.get('/api/health', async (_request, response) => {
    const workerMetrics = await queue.workerMetrics();
    response.json({
      status: 'ok',
      mode: repository.persistent ? 'persistent' : 'preview',
      queueConfigured: queue.configured,
      workerOnline: workerMetrics.online,
      workerCpuPercent: workerMetrics.cpuPercent,
      workerMemoryPercent: workerMetrics.memoryPercent,
      storageDriver: config.storageDriver,
      timestamp: new Date().toISOString(),
    });
  });
  app.use('/api/auth', loginLimiter, createAuthRouter(repository));
  app.use('/api/videos', createVideosRouter(repository, storage));
  app.use('/api/playlists', createPlaylistsRouter(repository));
  app.use('/api/live', createLiveRouter(repository, storage, queue));
  app.use('/api/schedules', createSchedulesRouter(repository, storage, queue));
  app.use('/api/notifications', createNotificationsRouter(repository));
  app.use('/api/admin', createAdminRouter(repository, queue));
  app.use('/api', createYoutubeRouter(repository));

  app.use('/api', (_request, response) => response.status(404).json({ error: 'API route not found.', code: 'not_found' }));
  const webDirectory = path.resolve(process.cwd(), 'apps/web/dist');
  if (fs.existsSync(webDirectory)) {
    app.use(express.static(webDirectory, { index: 'index.html', maxAge: config.production ? '1h' : 0 }));
    app.get(/.*/, (_request, response) => response.sendFile(path.join(webDirectory, 'index.html')));
  } else {
    app.get('/', (_request, response) => response.json({
      name: 'Maya Cloud Live API',
      preview: 'Run npm run dev to open the dashboard.',
      health: '/api/health',
    }));
  }

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    if (response.headersSent) return;
    const statusCode = Number((error as { status?: unknown })?.status) || 500;
    if (statusCode >= 500) console.error('API error:', error instanceof Error ? error.message : 'unknown error');
    response.status(statusCode >= 400 && statusCode < 600 ? statusCode : 500).json({
      error: statusCode >= 500 ? 'The server could not complete this request.' : error instanceof Error ? error.message : 'Request failed.',
      code: statusCode >= 500 ? 'server_error' : 'request_error',
    });
  };
  app.use(errorHandler);

  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`Maya API listening on 0.0.0.0:${config.port} (${repository.persistent ? 'PostgreSQL' : 'in-memory preview'})`);
  });

  const shutdown = async () => {
    console.log('Shutting down Maya API…');
    server.close();
    await Promise.allSettled([queue.close(), repository.close()]);
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

start().catch((error) => {
  console.error('Maya API failed to start:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
