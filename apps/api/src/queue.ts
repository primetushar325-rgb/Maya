import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { config } from './config';

export const STREAM_QUEUE_NAME = 'maya-streams';
export const CONTROL_QUEUE_NAME = 'maya-controls';
export const CONTROL_CHANNEL = 'maya:live-control';

export class QueueService {
  private readonly connection: Redis | null;
  private readonly queue: Queue | null;
  private readonly controlQueue: Queue | null;

  constructor() {
    this.connection = config.redisUrl ? new Redis(config.redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true }) : null;
    this.queue = this.connection ? new Queue(STREAM_QUEUE_NAME, { connection: this.connection }) : null;
    this.controlQueue = this.connection ? new Queue(CONTROL_QUEUE_NAME, { connection: this.connection }) : null;
  }

  get configured(): boolean {
    return Boolean(this.queue && this.connection);
  }

  get available(): boolean {
    return Boolean(this.queue && this.connection?.status === 'ready');
  }

  async waitUntilReady(): Promise<void> {
    if (!this.connection) throw new Error('Background queue is not configured. Start Redis and the streaming worker.');
    await this.connection.ping();
    await Promise.all([this.queue?.waitUntilReady(), this.controlQueue?.waitUntilReady()]);
  }

  async workerMetrics(): Promise<{ online: boolean; cpuPercent: number | null; memoryPercent: number | null }> {
    if (!this.connection) return { online: false, cpuPercent: null, memoryPercent: null };
    try {
      const raw = await this.connection.get('maya:worker:heartbeat');
      if (!raw) return { online: false, cpuPercent: null, memoryPercent: null };
      const data = JSON.parse(raw) as { cpuPercent?: number; memoryPercent?: number };
      return {
        online: true,
        cpuPercent: Number.isFinite(data.cpuPercent) ? Math.max(0, Math.min(100, Number(data.cpuPercent))) : null,
        memoryPercent: Number.isFinite(data.memoryPercent) ? Math.max(0, Math.min(100, Number(data.memoryPercent))) : null,
      };
    } catch { return { online: false, cpuPercent: null, memoryPercent: null }; }
  }

  async workerOnline(): Promise<boolean> {
    return (await this.workerMetrics()).online;
  }

  async enqueueStart(sessionId: string, delayMs = 0): Promise<void> {
    if (!this.queue) throw new Error('Background queue is not configured. Start Redis and the streaming worker.');
    await this.queue.add('start-live', { sessionId }, {
      jobId: sessionId,
      delay: Math.max(0, delayMs),
      removeOnComplete: { age: 86_400, count: 500 },
      removeOnFail: { age: 7 * 86_400, count: 1_000 },
      attempts: 1_000,
      backoff: { type: 'fixed', delay: 5_000 },
    });
  }

  async enqueueStopAt(sessionId: string, scheduledEnd: string): Promise<void> {
    if (!this.controlQueue) throw new Error('Background queue is not configured. Start Redis and the streaming worker.');
    await this.controlQueue.add('stop-live', { sessionId, action: 'stop' }, {
      jobId: `stop-${sessionId}`,
      delay: Math.max(0, Date.parse(scheduledEnd) - Date.now()),
      removeOnComplete: { age: 86_400, count: 500 },
      removeOnFail: { age: 7 * 86_400, count: 1_000 },
      attempts: 3,
      backoff: { type: 'exponential', delay: 2_000 },
    });
  }

  async publishControl(sessionId: string, action: 'stop' | 'restart'): Promise<void> {
    if (!this.connection) throw new Error('Background queue is not configured. Start Redis and the streaming worker.');
    await this.connection.publish(CONTROL_CHANNEL, JSON.stringify({ sessionId, action }));
  }

  async cancelScheduled(sessionId: string): Promise<void> {
    if (!this.queue) return;
    const job = await this.queue.getJob(sessionId);
    if (job) await job.remove().catch(() => undefined);
    const stopJob = await this.controlQueue?.getJob(`stop-${sessionId}`);
    if (stopJob) await stopJob.remove().catch(() => undefined);
  }

  async close(): Promise<void> {
    await Promise.all([this.queue?.close(), this.controlQueue?.close()]);
    await this.connection?.quit();
  }
}
