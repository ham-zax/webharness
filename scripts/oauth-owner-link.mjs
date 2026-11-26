import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const endpoint = '/admin/oauth/owner-link';
const lifetime = 5 * 60_000;
const ticketPattern = /^[A-Za-z0-9_-]{43}$/;
const directory = root => path.join(root, 'owner-approval-links');
const filename = (root, ticket) => path.join(directory(root), createHash('sha256').update(ticket).digest('hex'));
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function mintOwnerLink(root, externalUrl, input) {
  const url = new URL(input);
  const origin = new URL(externalUrl).origin;
  const q = url.searchParams;
  if (url.origin !== origin || url.username || url.password ||
      !['/authorize', '/admin/oauth/authorize'].includes(url.pathname) ||
      url.search.length > 16384 || new Set(q.keys()).size !== q.size ||
      q.get('response_type') !== 'code' || !q.get('client_id') || !q.get('redirect_uri') ||
      !q.get('scope')?.trim() || q.get('code_challenge_method') !== 'S256' ||
      !ticketPattern.test(q.get('code_challenge') ?? '')) {
    throw new Error('Expected an authorization URL for this bridge with explicit scopes, callback and S256 PKCE');
  }
  fs.mkdirSync(directory(root), { recursive: true, mode: 0o700 });
  const now = Date.now();
  for (const name of fs.readdirSync(directory(root))) {
    if (!/^[a-f0-9]{64}$/.test(name)) continue;
    const file = path.join(directory(root), name);
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (stat && stat.mtimeMs + lifetime < now) fs.rmSync(file, { force: true });
  }
  const ticket = randomBytes(32).toString('base64url');
  fs.writeFileSync(filename(root, ticket), JSON.stringify({ origin, query: url.search, expires: now + lifetime }),
    { flag: 'wx', mode: 0o600 });
  return origin + endpoint + '?ticket=' + ticket;
}

// Only a record written by the workstation supplies OAuth parameters. The SDK
// validates them again on both review and redemption before invoking our callback.
export function installOwnerLink(router, root, externalUrl, authRouter, oauthFlow) {
  router.all(endpoint, (req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'strict-origin',
      'Content-Security-Policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
    const post = req.method === 'POST';
    if (!post && req.method !== 'GET') return res.sendStatus(405);
    const origin = new URL(externalUrl).origin;
    if (post && req.headers.origin && req.headers.origin !== origin) return res.sendStatus(403);
    const ticket = req.query.ticket ?? (post && req.body?.ticket);
    if (typeof ticket !== 'string' || !ticketPattern.test(ticket)) return res.sendStatus(404);
    const file = filename(root, ticket);
    const action = post ? req.body?.action : undefined;
    if (post && !['approve', 'deny'].includes(action)) return res.sendStatus(400);
    let record;
    try {
      record = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (record.origin !== origin || record.expires <= Date.now()) return res.sendStatus(410);
    } catch (error) {
      if (error.code === 'ENOENT') return res.sendStatus(410);
      throw error;
    }
    const params = new URLSearchParams(record.query);
    const scopes = params.get('scope').trim().split(/\s+/);
    res.locals.ownerLinkConsent = async (client, validated, createRequest) => {
      if (validated.length !== new Set(scopes).size || !validated.every(s => scopes.includes(s))) {
        return res.status(400).send('The requested scopes do not match the effective grant.');
      }
      if (!post) {
        return res.type('html').send('<!doctype html><meta charset="utf-8"><title>Review access</title><h1>Review connector access</h1>' +
          '<dl><dt>Connector</dt><dd>' + escape(client.client_name || client.client_id) +
          '</dd><dt>Client ID</dt><dd>' + escape(client.client_id) +
          '</dd><dt>Callback</dt><dd>' + escape(params.get('redirect_uri')) +
          '</dd><dt>Permissions</dt><dd>' + escape(validated.join(' ')) +
          '</dd></dl><form method="post" action="' + endpoint + '"><input type="hidden" name="ticket" value="' + ticket +
          '"><button name="action" value="approve">Approve</button> <button name="action" value="deny">Deny</button></form>');
      }
      if (record.expires <= Date.now()) return res.sendStatus(410);
      // Unlink is the single-use claim across concurrent requests and processes.
      try { fs.unlinkSync(file); } catch (error) {
        if (error.code === 'ENOENT') return res.sendStatus(410);
        throw error;
      }
      const result = await oauthFlow.submitConsent({ authRequestId: createRequest(), action, scopes: validated });
      if (!['approved_redirect', 'denied_redirect'].includes(result.status)) return res.sendStatus(400);
      if (!req.headers.accept?.includes('text/html')) return res.redirect(303, result.redirectUrl);
      const target = escape(result.redirectUrl);
      return res.type('html').send('<!doctype html><meta http-equiv="refresh" content="0;url=' + target +
        '"><title>Returning to connector</title><a href="' + target + '">Continue</a>');
    };
    req.url = '/authorize' + record.query;
    if (post) req.body = Object.fromEntries(params);
    return authRouter(req, res, next);
  });
}
