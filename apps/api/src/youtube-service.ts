import { decryptSecret, encryptSecret } from '../../../packages/core/src/security';
import { validateYoutubeIngestAddress } from '../../../packages/core/src/validation';
import { YoutubeApi } from '../../../packages/core/src/youtube';
import type { Repository } from './repository';
import { config } from './config';

export const youtubeApi = new YoutubeApi(
  config.googleClientId,
  config.googleClientSecret,
  config.googleRedirectUri,
);

export class YoutubeService {
  async connectWithCode(repository: Repository, userId: string, code: string): Promise<{ channelId: string; channelTitle: string }> {
    const token = await youtubeApi.exchangeCode(code);
    const channel = await youtubeApi.getChannel(token.access_token);
    const old = await repository.getYoutubeConnection(userId);
    const refreshToken = token.refresh_token || (old ? decryptSecret(old.encryptedRefreshToken, config.encryptionSecret) : null);
    if (!refreshToken) throw new Error('Google did not issue a refresh token. Remove the app from Google account access and connect again.');
    const now = new Date();
    await repository.saveYoutubeConnection({
      userId,
      channelId: channel.id,
      channelTitle: channel.title,
      encryptedAccessToken: encryptSecret(token.access_token, config.encryptionSecret),
      encryptedRefreshToken: encryptSecret(refreshToken, config.encryptionSecret),
      expiresAt: new Date(now.getTime() + token.expires_in * 1000).toISOString(),
      createdAt: old?.createdAt || now.toISOString(),
      updatedAt: now.toISOString(),
    });
    return { channelId: channel.id, channelTitle: channel.title };
  }

  async accessToken(repository: Repository, userId: string): Promise<string> {
    const connection = await repository.getYoutubeConnection(userId);
    if (!connection) throw new Error('Connect a YouTube account before starting this stream.');
    if (Date.parse(connection.expiresAt) > Date.now() + 120_000) {
      return decryptSecret(connection.encryptedAccessToken, config.encryptionSecret);
    }
    const refreshToken = decryptSecret(connection.encryptedRefreshToken, config.encryptionSecret);
    const renewed = await youtubeApi.refreshAccessToken(refreshToken);
    const now = new Date();
    await repository.saveYoutubeConnection({
      ...connection,
      encryptedAccessToken: encryptSecret(renewed.access_token, config.encryptionSecret),
      encryptedRefreshToken: encryptSecret(renewed.refresh_token || refreshToken, config.encryptionSecret),
      expiresAt: new Date(now.getTime() + renewed.expires_in * 1000).toISOString(),
      updatedAt: now.toISOString(),
    });
    return renewed.access_token;
  }

  async createIngest(
    repository: Repository,
    input: { userId: string; title: string; description: string; privacyStatus: 'public' | 'unlisted' | 'private'; scheduledStart: string },
  ): Promise<{ broadcastId: string; streamId: string; ingestUrl: string }> {
    const accessToken = await this.accessToken(repository, input.userId);
    const broadcastId = await youtubeApi.createBroadcast(accessToken, input);
    const stream = await youtubeApi.createStream(accessToken, input.title);
    await youtubeApi.bindBroadcast(accessToken, broadcastId, stream.id);
    const ingestUrl = validateYoutubeIngestAddress(stream.ingestionAddress, stream.streamName);
    return { broadcastId, streamId: stream.id, ingestUrl };
  }

  async waitUntilLive(repository: Repository, userId: string, broadcastId: string, streamId: string): Promise<void> {
    const accessToken = await this.accessToken(repository, userId);
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const status = await youtubeApi.getStreamStatus(accessToken, streamId);
      if (status.streamStatus === 'active') {
        await youtubeApi.transitionBroadcast(accessToken, broadcastId, 'live');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    throw new Error('YouTube did not receive an active stream within two minutes. Check the channel and ingest health.');
  }

  async completeBroadcast(repository: Repository, userId: string, broadcastId: string | null): Promise<void> {
    if (!broadcastId) return;
    const accessToken = await this.accessToken(repository, userId);
    await youtubeApi.transitionBroadcast(accessToken, broadcastId, 'complete');
  }
}

export const youtubeService = new YoutubeService();
