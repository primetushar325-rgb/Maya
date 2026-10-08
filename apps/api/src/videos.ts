import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { parseFormBoolean, videoMetadataSchema, updateVideoSchema } from '../../../packages/core/src/validation';
import type { PublicVideo, VideoRecord } from '../../../packages/core/src/domain';
import type { Repository } from './repository';
import { ObjectStorage } from './storage';
import { config } from './config';
import { createThumbnail, probeMedia, validateVideoFile } from './media';
import { pathId, requireAuth } from './middleware';

const tempDirectory = path.join(config.dataDir, 'tmp');
mkdirSync(tempDirectory, { recursive: true });

function publicVideo(video: VideoRecord, previewAvailable: boolean): PublicVideo {
  const { objectKey: _objectKey, thumbnailKey, userId: _userId, ...safe } = video;
  return { ...safe, thumbnailUrl: thumbnailKey ? `/api/videos/${video.id}/thumbnail` : null, previewAvailable };
}

export function createVideosRouter(repository: Repository, storage: ObjectStorage): Router {
  const router = Router();
  const authenticated = requireAuth(repository);
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_request, _file, callback) => callback(null, tempDirectory),
      filename: (_request, file, callback) => callback(null, `${randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
    }),
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 8 },
    fileFilter: (_request, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase();
      if (!['.mp4', '.mov', '.mkv'].includes(extension)) {
        callback(new Error('Upload an MP4, MOV, or MKV video file.'));
        return;
      }
      callback(null, true);
    },
  });

  router.get('/', authenticated, async (request, response, next) => {
    try {
      const videos = await repository.listVideos(request.userId!);
      const safeVideos = await Promise.all(videos.map(async (video) => publicVideo(video, await storage.exists(video.objectKey))));
      response.json({ videos: safeVideos });
    } catch (error) { next(error); }
  });

  router.post('/', authenticated, upload.single('file'), async (request, response, next) => {
    const file = request.file;
    if (!file) return response.status(400).json({ error: 'Choose a video file to upload.', code: 'file_required' });
    let objectKey: string | null = null;
    let thumbnailKey: string | null = null;
    const thumbnailTemp = path.join(tempDirectory, `${randomUUID()}.jpg`);
    try {
      const metadataInput = videoMetadataSchema.safeParse({
        title: request.body.title,
        description: request.body.description || '',
        liveType: request.body.liveType || 'horizontal',
        loopEnabled: parseFormBoolean(request.body.loopEnabled),
      });
      if (!metadataInput.success) {
        return response.status(400).json({ error: metadataInput.error.issues[0]?.message || 'Video details are invalid.', code: 'invalid_video' });
      }
      await validateVideoFile(file.path, file.originalname);
      const media = await probeMedia(file.path);
      const id = randomUUID();
      objectKey = `${request.userId}/${id}/source${path.extname(file.originalname).toLowerCase()}`;
      await storage.putFile(objectKey, file.path, file.mimetype || 'application/octet-stream');
      if (await createThumbnail(file.path, thumbnailTemp)) {
        thumbnailKey = `${request.userId}/${id}/thumbnail.jpg`;
        await storage.putFile(thumbnailKey, thumbnailTemp, 'image/jpeg');
      }
      const now = new Date().toISOString();
      const video: VideoRecord = {
        id,
        userId: request.userId!,
        title: metadataInput.data.title,
        description: metadataInput.data.description,
        objectKey,
        thumbnailKey,
        originalName: path.basename(file.originalname).slice(0, 255),
        mimeType: file.mimetype || 'application/octet-stream',
        sizeBytes: file.size,
        durationSeconds: media.durationSeconds,
        width: media.width,
        height: media.height,
        fps: media.fps,
        videoCodec: media.videoCodec,
        audioCodec: media.audioCodec,
        liveType: metadataInput.data.liveType,
        loopEnabled: metadataInput.data.loopEnabled,
        status: 'ready',
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
      };
      const saved = await repository.createVideo(video);
      await repository.createNotification(request.userId!, 'upload_completed', 'Upload complete', `${saved.title} is ready in your library.`);
      response.status(201).json({ video: publicVideo(saved, true) });
    } catch (error) {
      if (objectKey) await storage.delete(objectKey).catch(() => undefined);
      if (thumbnailKey) await storage.delete(thumbnailKey).catch(() => undefined);
      const message = error instanceof Error ? error.message : 'Could not process this video.';
      response.status(message.includes('installed') ? 503 : 422).json({ error: message, code: 'video_processing_failed' });
    } finally {
      await rm(file.path, { force: true }).catch(() => undefined);
      await rm(thumbnailTemp, { force: true }).catch(() => undefined);
    }
  });

  router.patch('/:id', authenticated, async (request, response, next) => {
    try {
      const parsed = updateVideoSchema.safeParse(request.body);
      if (!parsed.success) return response.status(400).json({ error: parsed.error.issues[0]?.message || 'Video details are invalid.', code: 'invalid_video' });
      const video = await repository.updateVideo(request.userId!, pathId(request), parsed.data);
      if (!video) return response.status(404).json({ error: 'Video not found.', code: 'video_not_found' });
      response.json({ video: publicVideo(video, await storage.exists(video.objectKey)) });
    } catch (error) { next(error); }
  });

  router.delete('/:id', authenticated, async (request, response, next) => {
    try {
      const active = await repository.getActiveSession(request.userId!);
      const videoId = pathId(request);
      const activePlaylist = active?.playlistId ? await repository.getPlaylist(request.userId!, active.playlistId) : null;
      if (active?.videoId === videoId || activePlaylist?.items.some((item) => item.videoId === videoId)) {
        return response.status(409).json({ error: 'Stop the active stream before deleting a video it uses.', code: 'video_in_use' });
      }
      const video = await repository.deleteVideo(request.userId!, videoId);
      if (!video) return response.status(404).json({ error: 'Video not found.', code: 'video_not_found' });
      await storage.delete(video.objectKey);
      await storage.delete(video.thumbnailKey);
      response.status(204).end();
    } catch (error) { next(error); }
  });

  router.get('/:id/preview', authenticated, async (request, response, next) => {
    try {
      const video = await repository.getVideo(request.userId!, pathId(request));
      if (!video) return response.status(404).json({ error: 'Video not found.', code: 'video_not_found' });
      const rangeHeader = request.get('range');
      response.set('Accept-Ranges', 'bytes');
      response.type(video.mimeType || 'video/mp4');
      if (!rangeHeader) {
        response.set('Content-Length', String(video.sizeBytes));
        const stream = await storage.openReadStream(video.objectKey);
        stream.on('error', next);
        return stream.pipe(response);
      }
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      if (!match || (!match[1] && !match[2])) {
        response.set('Content-Range', `bytes */${video.sizeBytes}`);
        return response.status(416).end();
      }
      const suffixLength = match[1] ? 0 : Number(match[2]);
      const start = match[1] ? Number(match[1]) : Math.max(0, video.sizeBytes - suffixLength);
      const end = match[2] && match[1] ? Math.min(Number(match[2]), video.sizeBytes - 1) : video.sizeBytes - 1;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= video.sizeBytes) {
        response.set('Content-Range', `bytes */${video.sizeBytes}`);
        return response.status(416).end();
      }
      response.status(206);
      response.set('Content-Range', `bytes ${start}-${end}/${video.sizeBytes}`);
      response.set('Content-Length', String(end - start + 1));
      const stream = await storage.openReadStream(video.objectKey, { start, end });
      stream.on('error', next);
      return stream.pipe(response);
    } catch (error) { next(error); }
  });

  router.get('/:id/thumbnail', authenticated, async (request, response, next) => {
    try {
      const video = await repository.getVideo(request.userId!, pathId(request));
      if (!video?.thumbnailKey) return response.status(404).end();
      const stream = await storage.openReadStream(video.thumbnailKey);
      response.type('image/jpeg').set('Cache-Control', 'private, max-age=3600');
      stream.on('error', next);
      stream.pipe(response);
    } catch (error) { next(error); }
  });

  router.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (response.headersSent) return next(error);
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return response.status(413).json({ error: `Video exceeds the ${Math.round(config.maxUploadBytes / 1024 ** 3)} GB upload limit.`, code: 'upload_too_large' });
    }
    if (error instanceof Error && error.message.includes('Upload an MP4')) {
      return response.status(415).json({ error: error.message, code: 'unsupported_media' });
    }
    return response.status(400).json({ error: error instanceof Error ? error.message : 'Upload was rejected.', code: 'upload_rejected' });
  });

  return router;
}
