import type { LiveType } from './domain';

export interface StreamProfile {
  width: number;
  height: number;
  fps: 30;
  videoBitrateKbps: number;
  audioBitrateKbps: number;
  label: string;
}

export const STREAM_PROFILES: Record<LiveType, StreamProfile> = {
  vertical: {
    width: 1080,
    height: 1920,
    fps: 30,
    videoBitrateKbps: 4500,
    audioBitrateKbps: 160,
    label: 'Vertical 9:16',
  },
  horizontal: {
    width: 1920,
    height: 1080,
    fps: 30,
    videoBitrateKbps: 4500,
    audioBitrateKbps: 160,
    label: 'Horizontal 16:9',
  },
};

export function buildProfileArgs(
  inputPath: string,
  outputPath: string,
  liveType: LiveType,
  hasAudio: boolean,
  durationSeconds: number,
): string[] {
  const profile = STREAM_PROFILES[liveType];
  const args = ['-hide_banner', '-nostdin', '-y', '-i', inputPath];
  if (!hasAudio) {
    args.push(
      '-f', 'lavfi',
      '-t', String(Math.max(0.1, durationSeconds)),
      '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    );
  }
  args.push('-map', '0:v:0');
  args.push('-map', hasAudio ? '0:a:0' : '1:a:0');
  args.push(
    '-vf',
    `scale=${profile.width}:${profile.height}:force_original_aspect_ratio=decrease,pad=${profile.width}:${profile.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${profile.fps},format=yuv420p`,
    '-r', String(profile.fps),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-profile:v', 'high',
    '-level:v', '4.2',
    '-b:v', `${profile.videoBitrateKbps}k`,
    '-maxrate', `${profile.videoBitrateKbps}k`,
    '-bufsize', `${profile.videoBitrateKbps * 2}k`,
    '-g', String(profile.fps * 2),
    '-keyint_min', String(profile.fps * 2),
    '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', `${profile.audioBitrateKbps}k`,
    '-ar', '44100',
    '-ac', '2',
    '-movflags', '+faststart',
    '-shortest',
    outputPath,
  );
  return args;
}

export function buildConcatStreamArgs(
  manifestPath: string,
  ingestUrl: string,
  loopEnabled: boolean,
): string[] {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'warning', '-re'];
  if (loopEnabled) args.push('-stream_loop', '-1');
  args.push(
    '-f', 'concat',
    '-safe', '0',
    '-i', manifestPath,
    '-map', '0:v:0',
    '-map', '0:a:0',
    '-c:v', 'copy',
    '-c:a', 'copy',
    '-flvflags', 'no_duration_filesize',
    '-rw_timeout', '15000000',
    '-progress', 'pipe:1',
    '-stats_period', '5',
    '-f', 'flv',
    ingestUrl,
  );
  return args;
}

export function escapeConcatPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/'/g, "'\\''");
}

export function retryDelayMs(attempt: number, baseMs = 1_000, maximumMs = 30_000): number {
  const safeAttempt = Math.max(0, Math.min(20, Math.floor(attempt)));
  return Math.min(maximumMs, baseMs * 2 ** safeAttempt);
}

export function parseProgressLine(line: string): Record<string, string> | null {
  const divider = line.indexOf('=');
  if (divider <= 0) return null;
  return { [line.slice(0, divider).trim()]: line.slice(divider + 1).trim() };
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1_000))} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

export function safeFfmpegError(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const useful = lines.slice(-3).join(' ').replace(/\s+/g, ' ')
    .replace(/rtmps?:\/\/[^\s]+/gi, 'rtmp://[redacted]');
  return useful.slice(0, 500) || 'FFmpeg exited without a diagnostic message.';
}
