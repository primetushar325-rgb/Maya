import type { NextFunction, Request, Response } from 'express';
import { verifySession } from '../../../packages/core/src/security';
import { toSafeUser, type SafeUser } from '../../../packages/core/src/domain';
import { config } from './config';
import type { Repository } from './repository';

export const SESSION_COOKIE = 'maya_session';

declare global {
  namespace Express {
    interface Request {
      user?: SafeUser;
      userId?: string;
    }
  }
}

function readCookie(request: Request, cookieName: string): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const item of header.split(';')) {
    const [name, ...parts] = item.trim().split('=');
    if (name === cookieName) return decodeURIComponent(parts.join('='));
  }
  return null;
}

export function setSessionCookie(response: Response, token: string): void {
  response.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/',
    maxAge: 8 * 60 * 60 * 1000,
  });
}

export function clearSessionCookie(response: Response): void {
  response.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/',
  });
}

export function setOAuthStateCookie(response: Response, state: string): void {
  response.cookie('maya_oauth_state', state, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/api/youtube/callback',
    maxAge: 10 * 60 * 1000,
  });
}

export function readOAuthStateCookie(request: Request): string | null {
  return readCookie(request, 'maya_oauth_state');
}

export function clearOAuthStateCookie(response: Response): void {
  response.clearCookie('maya_oauth_state', {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/api/youtube/callback',
  });
}

export function requireAuth(repository: Repository) {
  return async (request: Request, response: Response, next: NextFunction) => {
    try {
      const token = readCookie(request, SESSION_COOKIE);
      const claims = token ? verifySession(token, config.jwtSecret) : null;
      if (!claims) return response.status(401).json({ error: 'Sign in to continue.', code: 'unauthorized' });
      const user = await repository.getUserById(claims.sub);
      if (!user || user.disabled) return response.status(401).json({ error: 'This account is unavailable.', code: 'account_unavailable' });
      request.user = toSafeUser(user);
      request.userId = user.id;
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function pathId(request: Request): string {
  const value = request.params.id;
  return Array.isArray(value) ? value[0] || '' : value || '';
}

export function requireAdmin(request: Request, response: Response, next: NextFunction): void {
  if (request.user?.role !== 'admin') {
    response.status(403).json({ error: 'Administrator permission is required.', code: 'forbidden' });
    return;
  }
  next();
}

export function protectUnsafeOrigins(request: Request, response: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next();
  const origin = request.get('origin');
  if (!origin) return next();
  try {
    const requestOrigin = new URL(origin);
    const allowed = new URL(config.appOrigin).origin;
    const localOriginAllowed = requestOrigin.origin === allowed;
    const arenaPreviewAllowed = !config.production && requestOrigin.hostname.endsWith('.e2b.app');
    if (!localOriginAllowed && !arenaPreviewAllowed) {
      response.status(403).json({ error: 'Request origin is not allowed.', code: 'origin_not_allowed' });
      return;
    }
  } catch {
    response.status(403).json({ error: 'Request origin is not allowed.', code: 'origin_not_allowed' });
    return;
  }
  next();
}
