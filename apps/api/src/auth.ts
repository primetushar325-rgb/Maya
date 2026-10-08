import { Router } from 'express';
import { loginSchema } from '../../../packages/core/src/validation';
import { signSession, verifyPassword } from '../../../packages/core/src/security';
import { toSafeUser } from '../../../packages/core/src/domain';
import type { Repository } from './repository';
import { clearSessionCookie, requireAuth, setSessionCookie } from './middleware';

export function createAuthRouter(repository: Repository): Router {
  const router = Router();
  const authenticated = requireAuth(repository);

  router.post('/login', async (request, response, next) => {
    try {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) return response.status(400).json({ error: 'Enter a valid email and password.', code: 'invalid_login' });
      const user = await repository.getUserByEmail(parsed.data.email);
      if (!user || user.disabled || !verifyPassword(parsed.data.password, user.passwordHash)) {
        return response.status(401).json({ error: 'Email or password did not match.', code: 'invalid_credentials' });
      }
      setSessionCookie(response, signSession(user.id, user.role, process.env.JWT_SECRET || 'maya-development-session-secret-only-for-local-use'));
      response.json({ user: toSafeUser(user) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/me', authenticated, (request, response) => {
    response.json({ user: request.user });
  });

  router.post('/logout', (_request, response) => {
    clearSessionCookie(response);
    response.status(204).end();
  });

  return router;
}
