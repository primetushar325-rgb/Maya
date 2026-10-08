const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

export interface YoutubeChannel {
  id: string;
  title: string;
}

export interface YoutubeIngest {
  broadcastId: string;
  streamId: string;
  ingestionAddress: string;
  streamName: string;
}

export class YoutubeApiError extends Error {
  constructor(message: string, readonly statusCode = 502, readonly reason = 'youtube_api_error') {
    super(message);
    this.name = 'YoutubeApiError';
  }
}

export class YoutubeApi {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.clientId && this.clientSecret && this.redirectUri);
  }

  authorizationUrl(state: string): string {
    this.assertConfigured();
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', `${YOUTUBE_SCOPE} openid email profile`);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('include_granted_scopes', 'true');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('state', state);
    return url.toString();
  }

  async exchangeCode(code: string): Promise<OAuthTokenResponse> {
    this.assertConfigured();
    const body = new URLSearchParams({
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
      grant_type: 'authorization_code',
    });
    return this.tokenRequest(body);
  }

  async refreshAccessToken(refreshToken: string): Promise<OAuthTokenResponse> {
    this.assertConfigured();
    const body = new URLSearchParams({
      refresh_token: refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: 'refresh_token',
    });
    return this.tokenRequest(body);
  }

  async getChannel(accessToken: string): Promise<YoutubeChannel> {
    const result = await this.apiRequest<{ items?: Array<{ id: string; snippet?: { title?: string } }> }>(
      '/channels?part=snippet&mine=true', accessToken,
    );
    const channel = result.items?.[0];
    if (!channel?.id) {
      throw new YoutubeApiError('No YouTube channel was returned for this Google account.', 422, 'channel_not_found');
    }
    return { id: channel.id, title: channel.snippet?.title || 'YouTube channel' };
  }

  async createBroadcast(
    accessToken: string,
    input: { title: string; description: string; privacyStatus: 'public' | 'unlisted' | 'private'; scheduledStart: string },
  ): Promise<string> {
    const result = await this.apiRequest<{ id?: string }>('/liveBroadcasts?part=snippet,status,contentDetails', accessToken, {
      method: 'POST',
      body: JSON.stringify({
        snippet: {
          title: input.title.slice(0, 100),
          description: input.description.slice(0, 5000),
          scheduledStartTime: input.scheduledStart,
        },
        status: { privacyStatus: input.privacyStatus },
        contentDetails: {
          enableAutoStart: false,
          enableAutoStop: false,
          recordFromStart: true,
          monitorStream: { enableMonitorStream: false },
        },
      }),
    });
    if (!result.id) throw new YoutubeApiError('YouTube did not return a broadcast ID.');
    return result.id;
  }

  async createStream(accessToken: string, title: string, resolution: '1080p' | '720p' = '1080p'): Promise<{
    id: string;
    ingestionAddress: string;
    streamName: string;
  }> {
    const result = await this.apiRequest<{
      id?: string;
      cdn?: { ingestionInfo?: { ingestionAddress?: string; streamName?: string } };
    }>('/liveStreams?part=snippet,cdn,contentDetails,status', accessToken, {
      method: 'POST',
      body: JSON.stringify({
        snippet: { title: title.slice(0, 100) },
        cdn: { ingestionType: 'rtmp', resolution, frameRate: '30fps' },
        contentDetails: { isReusable: false },
      }),
    });
    const ingestion = result.cdn?.ingestionInfo;
    if (!result.id || !ingestion?.ingestionAddress || !ingestion.streamName) {
      throw new YoutubeApiError('YouTube did not return usable stream ingestion details.');
    }
    return { id: result.id, ingestionAddress: ingestion.ingestionAddress, streamName: ingestion.streamName };
  }

  async bindBroadcast(accessToken: string, broadcastId: string, streamId: string): Promise<void> {
    await this.apiRequest(
      `/liveBroadcasts/bind?part=id&id=${encodeURIComponent(broadcastId)}&streamId=${encodeURIComponent(streamId)}`,
      accessToken,
      { method: 'POST' },
    );
  }

  async getStreamStatus(accessToken: string, streamId: string): Promise<{ streamStatus: string; healthStatus: string }> {
    const params = new URLSearchParams({ part: 'status', id: streamId });
    const result = await this.apiRequest<{
      items?: Array<{ status?: { streamStatus?: string; healthStatus?: { status?: string } } }>;
    }>(`/liveStreams?${params.toString()}`, accessToken);
    const status = result.items?.[0]?.status;
    if (!status) throw new YoutubeApiError('Could not read the YouTube stream status.', 502, 'stream_status_missing');
    return {
      streamStatus: status.streamStatus || 'unknown',
      healthStatus: status.healthStatus?.status || 'unknown',
    };
  }

  async transitionBroadcast(accessToken: string, broadcastId: string, status: 'live' | 'complete'): Promise<void> {
    const params = new URLSearchParams({ part: 'id,status', id: broadcastId, broadcastStatus: status });
    await this.apiRequest(`/liveBroadcasts/transition?${params.toString()}`, accessToken, { method: 'POST' });
  }

  private async tokenRequest(body: URLSearchParams): Promise<OAuthTokenResponse> {
    let response: Response;
    try {
      response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new YoutubeApiError('Could not reach Google OAuth. Try again shortly.', 502, 'oauth_network_error');
    }
    const payload = await response.json().catch(() => ({})) as OAuthTokenResponse & { error?: string };
    if (!response.ok || !payload.access_token) {
      throw new YoutubeApiError('Google OAuth could not authorize this YouTube connection.', response.status || 502, payload.error || 'oauth_failed');
    }
    return payload;
  }

  private async apiRequest<T = unknown>(path: string, accessToken: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${YOUTUBE_API}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
          ...(init.headers || {}),
        },
        signal: init.signal || AbortSignal.timeout(20_000),
      });
    } catch {
      throw new YoutubeApiError('Could not reach the YouTube Live API. Try again shortly.', 502, 'youtube_network_error');
    }
    const payload = await response.json().catch(() => ({})) as T & { error?: { message?: string; errors?: Array<{ reason?: string }> } };
    if (!response.ok) {
      const reason = payload.error?.errors?.[0]?.reason || 'youtube_api_error';
      const status = response.status === 401 ? 401 : response.status === 403 ? 403 : 502;
      const message = status === 403
        ? 'YouTube denied this request. Check channel live eligibility, permissions, quota, and active-stream limits.'
        : status === 401
          ? 'YouTube authorization expired. Reconnect the channel and try again.'
          : 'YouTube could not complete the requested live operation.';
      throw new YoutubeApiError(message, status, reason);
    }
    return payload;
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new YoutubeApiError('YouTube OAuth is not configured on this server.', 503, 'youtube_oauth_unconfigured');
    }
  }
}
