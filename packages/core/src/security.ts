import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

const PASSWORD_COST = 16_384;
const PASSWORD_BLOCK_SIZE = 8;
const PASSWORD_PARALLELISM = 1;
const SESSION_TTL_SECONDS = 8 * 60 * 60;

export interface SessionClaims {
  sub: string;
  role: 'user' | 'admin';
  iat: number;
  exp: number;
}

function encryptionKey(secret: string): Buffer {
  if (!secret || secret.length < 24) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY must contain at least 24 characters.');
  }
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function encryptSecret(plainText: string, secret: string): string {
  if (!plainText) throw new Error('Secret cannot be empty.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function decryptSecret(payload: string, secret: string): string {
  const [version, ivEncoded, tagEncoded, dataEncoded, extra] = payload.split('.');
  if (version !== 'v1' || !ivEncoded || !tagEncoded || !dataEncoded || extra) {
    throw new Error('Encrypted secret has an unsupported format.');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(secret),
    Buffer.from(ivEncoded, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagEncoded, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataEncoded, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function hashPassword(password: string): string {
  if (password.length < 10) throw new Error('Password must be at least 10 characters.');
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64, {
    N: PASSWORD_COST,
    r: PASSWORD_BLOCK_SIZE,
    p: PASSWORD_PARALLELISM,
  });
  return [
    'scrypt',
    PASSWORD_COST,
    PASSWORD_BLOCK_SIZE,
    PASSWORD_PARALLELISM,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

export function verifyPassword(password: string, encoded: string): boolean {
  try {
    const [algorithm, costText, blockText, parallelText, saltEncoded, expectedEncoded, extra] =
      encoded.split('$');
    if (
      algorithm !== 'scrypt' ||
      !costText ||
      !blockText ||
      !parallelText ||
      !saltEncoded ||
      !expectedEncoded ||
      extra
    ) return false;
    const expected = Buffer.from(expectedEncoded, 'base64url');
    const actual = scryptSync(password, Buffer.from(saltEncoded, 'base64url'), expected.length, {
      N: Number(costText),
      r: Number(blockText),
      p: Number(parallelText),
    });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function signSession(userId: string, role: 'user' | 'admin', secret: string, now = Date.now()): string {
  if (secret.length < 32) throw new Error('JWT_SECRET must contain at least 32 characters.');
  const issuedAt = Math.floor(now / 1000);
  const header = base64UrlJson({ alg: 'HS256', typ: 'JWT' });
  const claims: SessionClaims = {
    sub: userId,
    role,
    iat: issuedAt,
    exp: issuedAt + SESSION_TTL_SECONDS,
  };
  const body = base64UrlJson(claims);
  const input = `${header}.${body}`;
  const signature = createHmac('sha256', secret).update(input).digest('base64url');
  return `${input}.${signature}`;
}

export function verifySession(token: string, secret: string, now = Date.now()): SessionClaims | null {
  try {
    if (secret.length < 32) return null;
    const [headerEncoded, bodyEncoded, signature, extra] = token.split('.');
    if (!headerEncoded || !bodyEncoded || !signature || extra) return null;
    const header = JSON.parse(Buffer.from(headerEncoded, 'base64url').toString('utf8')) as { alg?: string };
    if (header.alg !== 'HS256') return null;
    const input = `${headerEncoded}.${bodyEncoded}`;
    const expected = createHmac('sha256', secret).update(input).digest();
    const supplied = Buffer.from(signature, 'base64url');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
    const claims = JSON.parse(Buffer.from(bodyEncoded, 'base64url').toString('utf8')) as SessionClaims;
    if (
      typeof claims.sub !== 'string' ||
      !['user', 'admin'].includes(claims.role) ||
      !Number.isFinite(claims.exp) ||
      claims.exp <= Math.floor(now / 1000)
    ) return null;
    return claims;
  } catch {
    return null;
  }
}

export function createOAuthState(): string {
  return randomBytes(32).toString('base64url');
}

export function shortFingerprint(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 10);
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/(rtmps?:\/\/[^\s/:]+(?::\d+)?\/[^\s]+)/gi, 'rtmp://[redacted]')
    .replace(/(stream[_ -]?key\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/(access[_ -]?token\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]');
}
