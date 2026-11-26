import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export function accessSettings(env = process.env) {
  if (env.MCP_BRIDGE_PROFILE !== 'server') return null;
  const team = env.WEBHARNESS_ACCESS_TEAM;
  const audience = env.WEBHARNESS_ACCESS_AUD;
  if (!team && !audience) return null;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(team ?? '') || !/^[a-f0-9]{64}$/.test(audience ?? '')) {
    throw new Error('Configure both WEBHARNESS_ACCESS_TEAM and WEBHARNESS_ACCESS_AUD for owner consent');
  }
  return { issuer: 'https://' + team + '.cloudflareaccess.com', audience };
}

export function accessConsentGuard(fallback, settings = accessSettings(), keys) {
  if (!settings) return fallback;
  const jwks = keys ?? createRemoteJWKSet(new URL('/cdn-cgi/access/certs', settings.issuer));
  const secret = randomBytes(32);
  return async (req, res, next) => {
    const path = req.originalUrl.split('?')[0].replace(/\/$/, '');
    if (path !== '/authorize' && path !== '/oauth/consent') return fallback(req, res, next);
    res.set('Cache-Control', 'no-store');
    try {
      const { payload } = await jwtVerify(req.get('Cf-Access-Jwt-Assertion'), jwks, {
        ...settings, algorithms: ['RS256'], requiredClaims: ['exp', 'sub', 'email'],
      });
      if (payload.type !== 'app' || typeof payload.email !== 'string' || !payload.email ||
          typeof payload.sub !== 'string' || !payload.sub) return res.sendStatus(403);
      const csrf = createHmac('sha256', secret).update(payload.sub).digest('hex');
      if (path === '/oauth/consent') {
        const submitted = req.body?.csrf_token;
        if (typeof submitted !== 'string' || !/^[a-f0-9]{64}$/.test(submitted) ||
            !timingSafeEqual(Buffer.from(csrf), Buffer.from(submitted))) return res.sendStatus(403);
      }
      res.locals.oauthConsentCsrfToken = csrf;
      res.locals.cloudflareOwnerConsent = true;
    } catch {
      return res.sendStatus(403);
    }
    next();
  };
}
