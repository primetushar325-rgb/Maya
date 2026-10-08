import 'dotenv/config';
import { cpus, freemem, hostname, loadavg, totalmem } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Worker, type Job } from 'bullmq';
import Redis from 'ioredis';
import { decryptSecret, redactSensitiveText } from '../../../packages/core/src/security';
import { buildConcatStreamArgs, buildProfileArgs, escapeConcatPath, parseProgressLine, retryDelayMs, safeFfmpegError, STREAM_PROFILES } from '../../../packages/core/src/streaming';
import type { LiveSessionRecord, VideoRecord } from '../../../packages/core/src/domain';
import { config } from '../../api/src/config';
import { Repository } from '../../api/src/repository';
import { ObjectStorage } from '../../api/src/storage';
import { CONTROL_CHANNEL, CONTROL_QUEUE_NAME, STREAM_QUEUE_NAME } from '../../api/src/queue';
import { probeMedia } from '../../api/src/media';
import { youtubeService } from '../../api/src/youtube-service';

interface RunningSession {
  child: ChildProcess | null;
  processingChild: ChildProcess | null;
  stopRequested: boolean;
  shutdownRequested: boolean;
  restartRequested: boolean;
  fatalError: string | null;
  hardKillTimer: NodeJS.Timeout | null;
}

interface ProgressState {
  values: Record<string, string>;
  lastWrittenAt: number;
  activated: boolean;
  currentIndex: number;
}

class RecoverableWorkerShutdownError extends Error {
  constructor() {
    super('Worker is shutting down; BullMQ will retry this stream job.');
    this.name = 'RecoverableWorkerShutdownError';
  }
}

const workerId = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
const repository = new Repository();
const storage = new ObjectStorage();
const running = new Map<string, RunningSession>();
let worker: Worker | null = null;
let controlWorker: Worker | null = null;
let subscriber: Redis | null = null;
let commandConnection: Redis | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let cpuSample: { usageMicros: number; wallMicros: number } | null = null;

async function collectWorkerMetrics(): Promise<{ cpuPercent: number; memoryPercent: number }> {
  let cpuPercent = Math.min(100, Math.max(0, (loadavg()[0] / Math.max(1, cpus().length)) * 100));
  try {
    const [stats, limits] = await Promise.all([
      readFile('/sys/fs/cgroup/cpu.stat', 'utf8'),
      readFile('/sys/fs/cgroup/cpu.max', 'utf8'),
    ]);
    const usage = Number(/^usage_usec\s+(\d+)/m.exec(stats)?.[1]);
    const [quotaText, periodText] = limits.trim().split(/\s+/);
    const quota = quotaText === 'max' ? cpus().length : Number(quotaText) / Number(periodText);
    const wallMicros = Number(process.hrtime.bigint() / 1_000n);
    if (Number.isFinite(usage) && Number.isFinite(quota) && quota > 0) {
      if (cpuSample) cpuPercent = ((usage - cpuSample.usageMicros) / Math.max(1, wallMicros - cpuSample.wallMicros) / quota) * 100;
      cpuSample = { usageMicros: usage, wallMicros };
    }
  } catch { /* cgroup metrics may be unavailable outside containers */ }

  let memoryPercent = (1 - freemem() / totalmem()) * 100;
  try {
    const [currentText, maximumText] = await Promise.all([
      readFile('/sys/fs/cgroup/memory.current', 'utf8'),
      readFile('/sys/fs/cgroup/memory.max', 'utf8'),
    ]);
    const current = Number(currentText.trim());
    const maximum = Number(maximumText.trim());
    if (Number.isFinite(current) && Number.isFinite(maximum) && maximum > 0) memoryPercent = current / maximum * 100;
  } catch {
    try {
      const [currentText, maximumText] = await Promise.all([
        readFile('/sys/fs/cgroup/memory/memory.usage_in_bytes', 'utf8'),
        readFile('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8'),
      ]);
      const current = Number(currentText.trim());
      const maximum = Number(maximumText.trim());
      if (Number.isFinite(current) && Number.isFinite(maximum) && maximum > 0 && maximum < Number.MAX_SAFE_INTEGER) memoryPercent = current / maximum * 100;
    } catch { /* use host memory usage */ }
  }
  return {
    cpuPercent: Number(Math.max(0, Math.min(100, cpuPercent)).toFixed(1)),
    memoryPercent: Number(Math.max(0, Math.min(100, memoryPercent)).toFixed(1)),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseFfmpegOutputLine(line: string, progress: ProgressState, sessionId: string): void {
  const pair = parseProgressLine(line);
  if (pair) Object.assign(progress.values, pair);
  if (progress.values.progress !== 'continue' && progress.values.progress !== 'end') return;
  const now = Date.now();
  const elapsed = Number(progress.values.out_time_ms || 0) / 1_000_000;
  const bitrate = Number.parseFloat(progress.values.bitrate || '') || 0;
  if (now - progress.lastWrittenAt > 10_000) {
    progress.lastWrittenAt = now;
    void repository.appendLog(sessionId, 'info', `Encoder progress: ${Math.floor(elapsed)} seconds sent${bitrate > 0 ? ` at ${Math.round(bitrate)} kb/s` : ''}.`).catch(() => undefined);
  }
}

async function runCommand(
  command: string,
  args: string[],
  timeoutMs = 60 * 60 * 1000,
  state?: RunningSession,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], shell: false });
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    if (state) state.processingChild = child;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (state?.processingChild === child) state.processingChild = null;
      if (error) reject(error);
      else resolve();
    };

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 10_000);
    }, timeoutMs);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-12_000); });
    child.once('error', (error) => {
      const message = error.message.includes('ENOENT') ? `${command} is not installed in the streaming worker.` : 'Could not launch media processing.';
      finish(new Error(message));
    });
    child.once('close', (code, signal) => {
      if (state?.shutdownRequested) return finish(new RecoverableWorkerShutdownError());
      if (state?.stopRequested) return finish(new Error('Media processing stopped by request.'));
      if (timedOut) return finish(new Error('Media processing exceeded its time limit.'));
      if (code === 0) return finish();
      finish(new Error(signal ? `Media processing stopped by ${signal}. ${safeFfmpegError(stderr)}` : safeFfmpegError(stderr)));
    });
  });
}

async function getPlaylistVideos(session: LiveSessionRecord): Promise<VideoRecord[]> {
  if (session.videoId) {
    const video = await repository.getVideo(session.userId, session.videoId);
    if (!video || video.status !== 'ready') throw new Error('The selected source video is not ready.');
    return [video];
  }
  if (!session.playlistId) throw new Error('The stream has no source video or playlist.');
  const playlist = await repository.getPlaylist(session.userId, session.playlistId);
  if (!playlist) throw new Error('The selected playlist no longer exists.');
  const items = [...playlist.items].sort((a, b) => a.position - b.position);
  if (!items.length) throw new Error('The selected playlist is empty.');
  const resolved = await Promise.all(items.map((item) => repository.getVideo(session.userId, item.videoId)));
  const videos: VideoRecord[] = [];
  for (const video of resolved) {
    const available = Boolean(video && video.status === 'ready' && await storage.exists(video.objectKey));
    if (!available) {
      if (!session.skipFailedVideos) throw new Error('A playlist video is unavailable or not ready.');
      await repository.appendLog(session.id, 'warn', `Skipped an unavailable playlist item${video ? `: ${video.title}` : ''}.`);
      continue;
    }
    videos.push(video!);
  }
  if (!videos.length) throw new Error('Every playlist item is unavailable; there is nothing to stream.');
  return videos;
}

async function validateProfile(filePath: string, liveType: LiveSessionRecord['liveType']): Promise<void> {
  const media = await probeMedia(filePath);
  const profile = STREAM_PROFILES[liveType];
  if (media.videoCodec !== 'h264' || media.audioCodec !== 'aac' || media.width !== profile.width || media.height !== profile.height) {
    throw new Error('The cached stream profile is invalid. Reprocess the source video before streaming.');
  }
}

async function ensureProfile(video: VideoRecord, liveType: LiveSessionRecord['liveType'], tempDir: string, sessionId: string, state: RunningSession): Promise<string> {
  const profileKey = `${video.userId}/processed/${video.id}/${liveType}-1080p30.mp4`;
  const outputPath = path.join(tempDir, `${video.id}-${liveType}.mp4`);
  if (await storage.exists(profileKey)) {
    await storage.downloadToFile(profileKey, outputPath);
    await validateProfile(outputPath, liveType);
    return outputPath;
  }
  const sourcePath = path.join(tempDir, `${video.id}-source${path.extname(video.originalName).toLowerCase() || '.mp4'}`);
  await storage.downloadToFile(video.objectKey, sourcePath);
  const media = await probeMedia(sourcePath);
  const ffmpegArgs = buildProfileArgs(sourcePath, outputPath, liveType, Boolean(media.audioCodec), media.durationSeconds);
  await runCommand(config.ffmpegBin, ffmpegArgs, Math.max(60 * 60 * 1000, media.durationSeconds * 4_000), state);
  await validateProfile(outputPath, liveType);
  await storage.putFile(profileKey, outputPath, 'video/mp4');
  await repository.appendLog(sessionId, 'info', `Cached ${liveType} profile for ${video.title}.`).catch(() => undefined);
  return outputPath;
}

function getScheduleForSession(sessionId: string, userId: string) {
  return repository.listSchedules(userId).then((schedules) => schedules.find((schedule) => schedule.sessionId === sessionId) || null);
}

async function markTerminal(session: LiveSessionRecord, status: 'ended' | 'failed', errorMessage: string | null): Promise<void> {
  const endedAt = new Date().toISOString();
  await repository.updateSession(session.id, {
    status, endedAt, workerId: null, healthStatus: status === 'failed' ? 'error' : 'unknown',
    errorMessage, bitrateKbps: null,
  });
  const schedule = await getScheduleForSession(session.id, session.userId);
  if (schedule) await repository.updateSchedule(schedule.id, status === 'failed' ? 'failed' : 'completed');
  if (session.youtubeBroadcastId) {
    await youtubeService.completeBroadcast(repository, session.userId, session.youtubeBroadcastId).catch(async (error) => {
      await repository.appendLog(session.id, 'warn', error instanceof Error ? `Could not end YouTube broadcast: ${error.message}` : 'Could not end YouTube broadcast.');
    });
  }
  await repository.createNotification(
    session.userId,
    status === 'failed' ? 'live_failed' : 'live_stopped',
    status === 'failed' ? 'Stream needs attention' : 'Live stream ended',
    status === 'failed' ? errorMessage || 'The stream worker could not continue.' : 'The server worker has ended the stream.',
  );
}

function terminateChildren(state: RunningSession, includeProcessing: boolean): void {
  const targets = includeProcessing ? [state.child, state.processingChild] : [state.child];
  const activeChildren = targets.filter((child): child is ChildProcess => Boolean(child && child.exitCode === null && child.signalCode === null));
  for (const child of activeChildren) child.kill('SIGTERM');
  if (activeChildren.length && !state.hardKillTimer) {
    state.hardKillTimer = setTimeout(() => {
      for (const child of [state.child, state.processingChild]) {
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
      state.hardKillTimer = null;
    }, 15_000);
  }
}

function requestStop(sessionId: string, action: 'stop' | 'restart'): void {
  const state = running.get(sessionId);
  if (!state) return;
  if (action === 'restart') state.restartRequested = true;
  else state.stopRequested = true;
  terminateChildren(state, action === 'stop');
}

async function runFfmpeg(session: LiveSessionRecord, sourceVideos: VideoRecord[], manifestPath: string, ingestUrl: string, state: RunningSession): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  wasActivated: boolean;
  fatalError: string | null;
}> {
  if (state.stopRequested) return { code: 0, signal: null, stderr: '', wasActivated: false, fatalError: null };
  if (state.restartRequested) {
    state.restartRequested = false;
    void repository.appendLog(session.id, 'info', 'Restart received before FFmpeg launch; starting with the current prepared profile.').catch(() => undefined);
  }
  const progress: ProgressState = { values: {}, lastWrittenAt: Date.now(), activated: false, currentIndex: 0 };
  const cumulative: number[] = [];
  let elapsed = 0;
  for (const video of sourceVideos) {
    cumulative.push(elapsed);
    elapsed += video.durationSeconds;
  }
  const child = spawn(config.ffmpegBin, buildConcatStreamArgs(manifestPath, ingestUrl, session.loopEnabled), {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    env: { ...process.env, AV_LOG_FORCE_NOCOLOR: '1' },
  });
  state.child = child;
  let stderr = '';
  let stdoutBuffer = '';
  let stderrBuffer = '';
  const activate = async () => {
    if (progress.activated) return;
    progress.activated = true;
    try {
      if (session.youtubeBroadcastId && session.youtubeStreamId) {
        await youtubeService.waitUntilLive(repository, session.userId, session.youtubeBroadcastId, session.youtubeStreamId);
      }
      if (state.stopRequested) return;
      await repository.updateSession(session.id, {
        status: 'live', healthStatus: 'healthy', startedAt: session.startedAt || new Date().toISOString(), errorMessage: null,
      });
      const schedule = await getScheduleForSession(session.id, session.userId);
      if (schedule) await repository.updateSchedule(schedule.id, 'started');
      await repository.appendLog(session.id, 'info', 'RTMP ingest is active; live session marked healthy.');
      await repository.createNotification(session.userId, 'live_started', 'You are live', `${session.liveType === 'vertical' ? 'Vertical 9:16' : 'Horizontal 16:9'} stream is active.`);
    } catch (error) {
      state.fatalError = error instanceof Error ? error.message : 'YouTube could not confirm the stream.';
      child.kill('SIGTERM');
    }
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      const pair = parseProgressLine(line);
      if (pair) Object.assign(progress.values, pair);
      if (progress.values.progress === 'continue' || progress.values.progress === 'end') {
        const currentTime = Number(progress.values.out_time_ms || 0) / 1_000_000;
        const playlistTime = session.loopEnabled && elapsed > 0 ? currentTime % elapsed : currentTime;
        progress.currentIndex = 0;
        for (let index = 0; index < cumulative.length; index += 1) {
          if (playlistTime >= cumulative[index]) progress.currentIndex = index;
        }
        const fps = Number(progress.values.fps || 0);
        const bitrate = Number.parseFloat(progress.values.bitrate || '') || 0;
        const droppedFrames = Number(progress.values.drop_frames);
        void repository.updateSession(session.id, {
          currentVideoId: sourceVideos[Math.min(progress.currentIndex, sourceVideos.length - 1)]?.id || session.currentVideoId,
          ...(fps > 0 ? { fps: Number(fps.toFixed(2)) } : {}),
          ...(bitrate > 0 ? { bitrateKbps: Math.round(bitrate) } : {}),
          ...(progress.values.drop_frames !== undefined && Number.isFinite(droppedFrames) ? { droppedFrames: Math.max(0, Math.floor(droppedFrames)) } : {}),
        }).catch(() => undefined);
        void activate();
        parseFfmpegOutputLine(line, progress, session.id);
      }
    }
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
    stderr = stderr.slice(-20_000);
    stderrBuffer += chunk;
    const lines = stderrBuffer.split(/\r?\n/);
    stderrBuffer = lines.pop() || '';
    for (const line of lines) {
      const safe = redactSensitiveText(line.trim());
      if (safe && /(error|failed|warning|connection|reconnect)/i.test(safe)) {
        void repository.appendLog(session.id, /error|failed/i.test(safe) ? 'warn' : 'info', safe).catch(() => undefined);
      }
    }
  });

  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (state.hardKillTimer) clearTimeout(state.hardKillTimer);
      state.hardKillTimer = null;
      state.child = null;
      resolve({ code, signal, stderr: redactSensitiveText(stderr), wasActivated: progress.activated, fatalError: state.fatalError });
    };
    child.once('error', (error) => finish(null, null));
    child.once('close', (code, signal) => finish(code, signal));
  });
}

async function processSession(sessionId: string): Promise<void> {
  const session = await repository.getSession(sessionId);
  if (!session) return;
  const state: RunningSession = { child: null, processingChild: null, stopRequested: false, shutdownRequested: false, restartRequested: false, fatalError: null, hardKillTimer: null };
  running.set(sessionId, state);
  try {
    if (session.status === 'stopping') {
      await markTerminal(session, 'ended', null);
      return;
    }
    if (['ended', 'failed'].includes(session.status)) return;
    const claimed = await repository.claimSession(sessionId, workerId);
    if (!claimed) {
      await repository.appendLog(sessionId, 'warn', 'Worker skipped duplicate or non-claimable stream job.');
      return;
    }
    const current = await repository.getSession(sessionId) || claimed;
    await repository.appendLog(sessionId, 'info', `Worker ${workerId} acquired the stream job.`);
    const videos = await getPlaylistVideos(current);
    const tempParent = path.join(config.dataDir, 'worker');
    await mkdir(tempParent, { recursive: true });
    const tempDir = await mkdtemp(path.join(tempParent, `${sessionId}-`));
    try {
      const profilePaths: string[] = [];
      const streamVideos: VideoRecord[] = [];
      for (const video of videos) {
        if (state.shutdownRequested) throw new RecoverableWorkerShutdownError();
        if (state.stopRequested) break;
        try {
          const profilePath = await ensureProfile(video, current.liveType, tempDir, sessionId, state);
          if (state.shutdownRequested) throw new RecoverableWorkerShutdownError();
          if (state.stopRequested) break;
          profilePaths.push(profilePath);
          streamVideos.push(video);
        } catch (error) {
          if (state.shutdownRequested) throw new RecoverableWorkerShutdownError();
          if (state.stopRequested) break;
          if (current.playlistId && current.skipFailedVideos) {
            await repository.appendLog(sessionId, 'warn', `Skipped ${video.title} after profile processing failed: ${error instanceof Error ? error.message : 'media error'}`);
            continue;
          }
          throw error;
        }
      }
      if (state.stopRequested) {
        await markTerminal(current, 'ended', null);
        return;
      }
      if (state.restartRequested) {
        state.restartRequested = false;
        await repository.appendLog(sessionId, 'info', 'Restart received while preparing; continuing with the freshly prepared stream.');
      }
      if (profilePaths.length === 0) throw new Error('No playlist items could be prepared for streaming.');
      const manifestPath = path.join(tempDir, 'playlist.ffconcat');
      const manifest = profilePaths.map((filePath) => `file '${escapeConcatPath(filePath)}'`).join('\n');
      await writeFile(manifestPath, `${manifest}\n`, { mode: 0o600 });
      if (!current.encryptedIngestUrl) throw new Error('The session has no encrypted ingest destination.');
      const ingestUrl = decryptSecret(current.encryptedIngestUrl, config.encryptionSecret);
      if (!ingestUrl.startsWith('rtmp://') && !ingestUrl.startsWith('rtmps://')) throw new Error('The configured ingest URL is invalid.');
      let attempts = current.reconnectAttempts;
      while (!state.stopRequested) {
        await repository.updateSession(sessionId, {
          status: attempts ? 'reconnecting' : 'starting',
          healthStatus: attempts ? 'warning' : 'unknown',
          reconnectAttempts: attempts,
          workerId,
          errorMessage: null,
        });
        if (attempts) await repository.appendLog(sessionId, 'warn', `Reconnecting to RTMP ingest (attempt ${attempts}).`);
        const result = await runFfmpeg(current, streamVideos, manifestPath, ingestUrl, state);
        if (state.shutdownRequested) throw new RecoverableWorkerShutdownError();
        if (state.stopRequested) {
          await repository.appendLog(sessionId, 'info', 'FFmpeg stopped after a user or administrator request.');
          await markTerminal(current, 'ended', null);
          return;
        }
        if (state.fatalError || result.fatalError) {
          await repository.appendLog(sessionId, 'error', state.fatalError || result.fatalError || 'YouTube could not start the broadcast.');
          await markTerminal(current, 'failed', state.fatalError || result.fatalError);
          return;
        }
        if (state.restartRequested) {
          state.restartRequested = false;
          attempts = 0;
          await repository.appendLog(sessionId, 'warn', 'Restarting FFmpeg as requested.');
          continue;
        }
        if (result.code === 0 && result.wasActivated && !current.loopEnabled) {
          await repository.appendLog(sessionId, 'info', 'Source reached its natural end; loop is disabled.');
          await markTerminal(current, 'ended', null);
          return;
        }
        attempts += 1;
        await repository.updateSession(sessionId, {
          status: 'reconnecting', healthStatus: 'warning', reconnectAttempts: attempts,
          errorMessage: safeFfmpegError(result.stderr), workerId,
        });
        await repository.appendLog(sessionId, 'warn', `FFmpeg exited (code ${result.code ?? 'unknown'}). ${safeFfmpegError(result.stderr)}`);
        if (attempts > config.maxReconnectAttempts) {
          await markTerminal(current, 'failed', `Reconnect limit reached after ${config.maxReconnectAttempts} attempts.`);
          return;
        }
        await delay(retryDelayMs(attempts - 1));
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  } catch (error) {
    if (state.shutdownRequested) {
      await repository.updateSession(sessionId, {
        status: 'reconnecting', healthStatus: 'warning', workerId: null, errorMessage: null,
      }).catch(() => undefined);
      await repository.appendLog(sessionId, 'warn', 'Worker is restarting; BullMQ will recover this stream job.').catch(() => undefined);
      throw error instanceof RecoverableWorkerShutdownError ? error : new RecoverableWorkerShutdownError();
    }
    if (state.stopRequested) {
      await repository.appendLog(sessionId, 'info', 'Stream preparation stopped by user or administrator request.').catch(() => undefined);
      await markTerminal(session, 'ended', null).catch(() => undefined);
      return;
    }
    const message = error instanceof Error ? error.message : 'Unexpected streaming worker error.';
    await repository.appendLog(sessionId, 'error', message).catch(() => undefined);
    await markTerminal(session, 'failed', message).catch(() => undefined);
  } finally {
    if (state.hardKillTimer) clearTimeout(state.hardKillTimer);
    running.delete(sessionId);
  }
}

async function handleStopJob(sessionId: string): Promise<void> {
  requestStop(sessionId, 'stop');
  const state = running.get(sessionId);
  if (state) return;
  const session = await repository.getSession(sessionId);
  if (session && !['ended', 'failed'].includes(session.status)) {
    await markTerminal(session, 'ended', null);
  }
}

async function processJob(job: Job): Promise<void> {
  const sessionId = typeof job.data?.sessionId === 'string' ? job.data.sessionId : '';
  if (!sessionId) throw new Error('Queue job is missing its session ID.');
  if (job.name === 'start-live') return processSession(sessionId);
  throw new Error(`Unsupported stream job: ${job.name}`);
}

async function processControlJob(job: Job): Promise<void> {
  const sessionId = typeof job.data?.sessionId === 'string' ? job.data.sessionId : '';
  if (!sessionId) throw new Error('Control job is missing its session ID.');
  if (job.name === 'stop-live') return handleStopJob(sessionId);
  throw new Error(`Unsupported control job: ${job.name}`);
}

async function startWorker(): Promise<void> {
  if (!config.databaseUrl || !config.redisUrl) {
    throw new Error('The streaming worker requires DATABASE_URL and REDIS_URL. Use Docker Compose or configure both services.');
  }
  await Promise.all([
    runCommand(config.ffmpegBin, ['-version'], 10_000),
    runCommand(config.ffprobeBin, ['-version'], 10_000),
  ]);
  await repository.init();
  await storage.init();
  commandConnection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  subscriber = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  await Promise.all([commandConnection.ping(), subscriber.ping()]);
  const publishHeartbeat = async () => {
    const metrics = await collectWorkerMetrics();
    await commandConnection?.set('maya:worker:heartbeat', JSON.stringify({ workerId, ...metrics, updatedAt: new Date().toISOString() }), 'PX', 20_000).catch(() => undefined);
  };
  await publishHeartbeat();
  heartbeatTimer = setInterval(() => { void publishHeartbeat(); }, 5_000);
  await subscriber.subscribe(CONTROL_CHANNEL);
  subscriber.on('message', (_channel, raw) => {
    try {
      const message = JSON.parse(raw) as { sessionId?: string; action?: 'stop' | 'restart' };
      if (message.sessionId && (message.action === 'stop' || message.action === 'restart')) {
        requestStop(message.sessionId, message.action);
      }
    } catch {
      console.warn('Ignored malformed stream control message.');
    }
  });
  worker = new Worker(STREAM_QUEUE_NAME, processJob, {
    connection: new Redis(config.redisUrl, { maxRetriesPerRequest: null }),
    concurrency: config.workerConcurrency,
    lockDuration: 60_000,
    stalledInterval: 30_000,
  });
  controlWorker = new Worker(CONTROL_QUEUE_NAME, processControlJob, {
    connection: new Redis(config.redisUrl, { maxRetriesPerRequest: null }),
    concurrency: 100,
    lockDuration: 30_000,
    stalledInterval: 15_000,
  });
  worker.on('completed', (job) => console.log(`Stream job ${job.id} completed.`));
  worker.on('failed', (job, error) => console.error(`Stream job ${job?.id || 'unknown'} failed:`, error.message));
  worker.on('error', (error) => console.error('BullMQ stream worker error:', error.message));
  controlWorker.on('failed', (job, error) => console.error(`Control job ${job?.id || 'unknown'} failed:`, error.message));
  controlWorker.on('error', (error) => console.error('BullMQ control worker error:', error.message));
  console.log(`Maya streaming worker ${workerId} is listening (stream concurrency ${config.workerConcurrency}).`);
}

async function shutdown(): Promise<void> {
  console.log('Stopping stream worker…');
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  for (const [sessionId, state] of running) {
    state.shutdownRequested = true;
    terminateChildren(state, true);
    await repository.appendLog(sessionId, 'warn', 'Worker is shutting down; BullMQ will retry the stream after restart.').catch(() => undefined);
  }
  await Promise.all([worker?.close(), controlWorker?.close()]);
  await Promise.allSettled([subscriber?.quit(), commandConnection?.quit(), repository.close()]);
  process.exit(0);
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
startWorker().catch((error) => {
  console.error('Maya streaming worker could not start:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
