import { createReadStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { config } from './config';

export class ObjectStorage {
  private readonly s3: S3Client | null;
  readonly root: string;

  constructor() {
    this.root = path.join(config.dataDir, 'objects');
    this.s3 = config.storageDriver === 's3'
      ? new S3Client({
          region: config.s3.region,
          endpoint: config.s3.endpoint,
          forcePathStyle: config.s3.forcePathStyle,
          credentials: config.s3.accessKey && config.s3.secretKey
            ? { accessKeyId: config.s3.accessKey, secretAccessKey: config.s3.secretKey }
            : undefined,
        })
      : null;
  }

  async init(): Promise<void> {
    if (!this.s3) await mkdir(this.root, { recursive: true });
  }

  localPath(key: string): string {
    const normalized = key.replace(/\\/g, '/').replace(/^\/+/, '');
    const target = path.resolve(this.root, normalized);
    if (!target.startsWith(`${path.resolve(this.root)}${path.sep}`)) {
      throw new Error('Storage key is outside the configured object directory.');
    }
    return target;
  }

  async putFile(key: string, filePath: string, contentType: string): Promise<void> {
    if (this.s3) {
      await new Upload({
        client: this.s3,
        params: {
          Bucket: config.s3.bucket,
          Key: key,
          Body: createReadStream(filePath),
          ContentLength: (await stat(filePath)).size,
          ContentType: contentType,
        },
        queueSize: 4,
        partSize: 8 * 1024 * 1024,
        leavePartsOnError: false,
      }).done();
      return;
    }
    const target = this.localPath(key);
    await mkdir(path.dirname(target), { recursive: true });
    const { copyFile } = await import('node:fs/promises');
    await copyFile(filePath, target);
  }

  async downloadToFile(key: string, targetPath: string): Promise<void> {
    await mkdir(path.dirname(targetPath), { recursive: true });
    if (this.s3) {
      const result = await this.s3.send(new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }));
      if (!result.Body) throw new Error('Stored video object is empty.');
      await pipeline(result.Body as unknown as Readable, createWriteStream(targetPath, { mode: 0o600 }));
      return;
    }
    const sourcePath = this.localPath(key);
    const { copyFile } = await import('node:fs/promises');
    await copyFile(sourcePath, targetPath);
  }

  async openReadStream(key: string, range?: { start: number; end: number }): Promise<Readable> {
    if (!this.s3) return createReadStream(this.localPath(key), range);
    const result = await this.s3.send(new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
    }));
    if (!result.Body) throw new Error('Stored object is empty.');
    return result.Body as unknown as Readable;
  }

  async exists(key: string): Promise<boolean> {
    if (this.s3) {
      try {
        await this.s3.send(new HeadObjectCommand({ Bucket: config.s3.bucket, Key: key }));
        return true;
      } catch (error) {
        const name = (error as { name?: string }).name;
        if (name === 'NotFound' || name === 'NoSuchKey' || name === 'NotFoundException') return false;
        throw error;
      }
    }
    try {
      await stat(this.localPath(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string | null): Promise<void> {
    if (!key) return;
    if (this.s3) {
      await this.s3.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: key }));
      return;
    }
    await rm(this.localPath(key), { force: true });
  }
}
