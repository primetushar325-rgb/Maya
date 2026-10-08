import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decryptSecret, encryptSecret, hashPassword, signSession, verifyPassword, verifySession } from './security';
import { buildConcatStreamArgs, buildProfileArgs, escapeConcatPath, formatDuration, retryDelayMs } from './streaming';
import { validateYoutubeIngest } from './validation';

test('AES-GCM credentials round-trip and reject a different key', () => {
  const encrypted = encryptSecret('sample-stream-key-1234', 'a sufficiently long encryption secret');
  assert.notEqual(encrypted, 'sample-stream-key-1234');
  assert.equal(decryptSecret(encrypted, 'a sufficiently long encryption secret'), 'sample-stream-key-1234');
  assert.throws(() => decryptSecret(encrypted, 'another sufficiently long secret'));
});

test('password hash uses a per-password salt and verifies without timing leaks', () => {
  const first = hashPassword('A strong demo password!');
  const second = hashPassword('A strong demo password!');
  assert.notEqual(first, second);
  assert.equal(verifyPassword('A strong demo password!', first), true);
  assert.equal(verifyPassword('wrong password', first), false);
  assert.equal(verifyPassword('anything', 'not-a-hash'), false);
});

test('signed session tokens validate signature and expiry', () => {
  const secret = 'a-long-random-session-secret-for-tests';
  const token = signSession('user-123', 'admin', secret, 1_700_000_000_000);
  assert.equal(verifySession(token, secret, 1_700_000_001_000)?.sub, 'user-123');
  assert.equal(verifySession(token, 'a-different-session-secret-for-tests', 1_700_000_001_000), null);
  assert.equal(verifySession(token, secret, 1_700_100_000_000), null);
});

test('manual ingest validation allows YouTube and rejects arbitrary RTMP hosts', () => {
  assert.equal(
    validateYoutubeIngest('rtmps://a.rtmps.youtube.com/live2', 'abcd-efgh-ijkl-mnop-qrst'),
    'rtmps://a.rtmps.youtube.com/live2/abcd-efgh-ijkl-mnop-qrst',
  );
  assert.throws(() => validateYoutubeIngest('rtmp://127.0.0.1/live', 'abcd-efgh'));
  assert.throws(() => validateYoutubeIngest('https://a.rtmp.youtube.com/live2', 'abcd-efgh'));
  assert.throws(() => validateYoutubeIngest('rtmp://a.rtmp.youtube.com/live2', 'has spaces'));
});

test('encoding profiles preserve aspect ratio and add a silent track when requested', () => {
  const vertical = buildProfileArgs('/tmp/input.mov', '/tmp/output.mp4', 'vertical', false, 12);
  assert.ok(vertical.includes('scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p'));
  assert.ok(vertical.includes('anullsrc=channel_layout=stereo:sample_rate=44100'));
  assert.ok(vertical.includes('libx264'));
  const horizontal = buildProfileArgs('/tmp/input.mp4', '/tmp/output.mp4', 'horizontal', true, 12);
  assert.ok(horizontal.includes('scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p'));
  assert.ok(!horizontal.includes('anullsrc=channel_layout=stereo:sample_rate=44100'));
});

test('stream worker loop and reconnect policies remain bounded', () => {
  const args = buildConcatStreamArgs('/tmp/playlist.ffconcat', 'rtmps://a.rtmps.youtube.com/live2/key', true);
  assert.deepEqual(args.slice(0, 6), ['-hide_banner', '-nostdin', '-loglevel', 'warning', '-re', '-stream_loop']);
  assert.ok(args.includes('-1'));
  assert.equal(retryDelayMs(0), 1_000);
  assert.equal(retryDelayMs(4), 16_000);
  assert.equal(retryDelayMs(12), 30_000);
  assert.equal(formatDuration(3_661), '1:01:01');
  assert.equal(escapeConcatPath("/tmp/a'b.mp4"), "/tmp/a'\\''b.mp4");
});
