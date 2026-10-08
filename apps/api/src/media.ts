import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config';

const execFileAsync = promisify(execFile);

export interface MediaMetadata {
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  audioCodec: string | null;
}

function parseRate(value: string | undefined): number {
  if (!value || value === '0/0') return 0;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return Number(value) || 0;
  return numerator / denominator;
}

export async function validateVideoFile(filePath: string, originalName: string): Promise<void> {
  const extension = path.extname(originalName).toLowerCase();
  if (!['.mp4', '.mov', '.mkv'].includes(extension)) {
    throw new Error('Upload an MP4, MOV, or MKV video file.');
  }
  const handle = await open(filePath, 'r');
  const header = Buffer.alloc(16);
  try {
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 4) throw new Error('The uploaded file is too small to be a valid video.');
  } finally {
    await handle.close();
  }
  const isMp4Family = header.length >= 8 && header.toString('ascii', 4, 8) === 'ftyp';
  const isMkv = header.length >= 4 && header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (!isMp4Family && !isMkv) throw new Error('The file does not look like a supported video container.');
  if (extension === '.mkv' && !isMkv) throw new Error('The MKV file signature could not be validated.');
  if ((extension === '.mp4' || extension === '.mov') && !isMp4Family) {
    throw new Error('The MP4/MOV file signature could not be validated.');
  }
}

export async function probeMedia(filePath: string): Promise<MediaMetadata> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(config.ffprobeBin, [
      '-v', 'error',
      '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate',
      '-of', 'json',
      filePath,
    ], { timeout: 45_000, maxBuffer: 2 * 1024 * 1024 }));
  } catch {
    throw new Error('Video inspection failed. Check that the file is playable and that ffprobe is installed.');
  }
  let result: { streams?: Array<Record<string, unknown>>; format?: { duration?: string } };
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error('Video inspection returned an invalid result.');
  }
  const video = result.streams?.find((stream) => stream.codec_type === 'video');
  const audio = result.streams?.find((stream) => stream.codec_type === 'audio');
  if (!video) throw new Error('The uploaded file does not contain a video stream.');
  const durationSeconds = Number(result.format?.duration || 0);
  const width = Number(video.width || 0);
  const height = Number(video.height || 0);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !width || !height) {
    throw new Error('Could not read the video duration or resolution.');
  }
  if (durationSeconds > 24 * 60 * 60) throw new Error('Videos longer than 24 hours are not supported.');
  return {
    durationSeconds,
    width,
    height,
    fps: Number(parseRate(String(video.avg_frame_rate || video.r_frame_rate || '0/0')).toFixed(2)),
    videoCodec: String(video.codec_name || 'unknown'),
    audioCodec: audio?.codec_name ? String(audio.codec_name) : null,
  };
}

export async function createThumbnail(inputPath: string, outputPath: string): Promise<boolean> {
  try {
    await execFileAsync(config.ffmpegBin, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-ss', '00:00:01', '-i', inputPath,
      '-frames:v', '1', '-vf', 'scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2',
      '-q:v', '3', outputPath,
    ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}
