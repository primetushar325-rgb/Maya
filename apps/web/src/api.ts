import type { AdminOverview, Destination, Health, LiveSession, Notification, Playlist, Schedule, User, Video, YoutubeStatus } from './types';

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

type ApiOptions = Omit<RequestInit, 'body'> & { body?: unknown };

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  let body: BodyInit | undefined;
  if (options.body instanceof FormData || options.body instanceof Blob || typeof options.body === 'string') {
    body = options.body as BodyInit;
  } else if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(options.body);
  }
  const response = await fetch(`/api${path}`, {
    ...options,
    headers,
    body,
    credentials: 'include',
  });
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => ({})) as { error?: string; code?: string } & T;
  if (!response.ok) throw new ApiError(payload.error || 'Request failed. Please try again.', response.status, payload.code);
  return payload;
}

export async function uploadVideo(
  file: File,
  metadata: { title: string; description: string; liveType: string; loopEnabled: boolean },
  onProgress: (progress: number) => void,
): Promise<Video> {
  const form = new FormData();
  form.append('file', file);
  form.append('title', metadata.title);
  form.append('description', metadata.description);
  form.append('liveType', metadata.liveType);
  form.append('loopEnabled', String(metadata.loopEnabled));
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/videos');
    request.withCredentials = true;
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onerror = () => reject(new ApiError('Network upload failed. Check your connection and try again.', 0));
    request.onload = () => {
      let payload: { video?: Video; error?: string; code?: string } = {};
      try { payload = JSON.parse(request.responseText); } catch { /* API returned no JSON */ }
      if (request.status < 200 || request.status >= 300 || !payload.video) {
        reject(new ApiError(payload.error || 'The video could not be uploaded.', request.status, payload.code));
        return;
      }
      onProgress(100);
      resolve(payload.video);
    };
    request.send(form);
  });
}

export const API = {
  me: () => api<{ user: User }>('/auth/me'),
  health: () => api<Health>('/health'),
  videos: () => api<{ videos: Video[] }>('/videos'),
  playlists: () => api<{ playlists: Playlist[] }>('/playlists'),
  destination: () => api<{ destination: Destination }>('/destination'),
  youtubeStatus: () => api<YoutubeStatus>('/youtube/status'),
  current: () => api<{ session: LiveSession | null }>('/live/current'),
  sessions: () => api<{ sessions: LiveSession[] }>('/live'),
  schedules: () => api<{ schedules: Schedule[] }>('/schedules'),
  notifications: () => api<{ notifications: Notification[] }>('/notifications'),
  adminOverview: () => api<AdminOverview>('/admin/overview'),
};
