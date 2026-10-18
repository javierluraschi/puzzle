// Sign-in with Cloudish (OpenID Connect, Authorization Code + PKCE, no client secret).
//   GET  /auth/login?return=/p/...   redirects to Cloudish
//   GET  /auth/callback              exchanges the code, verifies the id_token, sets the session cookie
//   POST /auth/logout                clears the session cookie
// The session is a cookie signed with a secret kept on the data volume, so it survives redeploys.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from './store.js';

const ISSUER = process.env.OIDC_ISSUER || 'https://www.cloudish.ai';
const CLIENT_ID = process.env.OIDC_CLIENT_ID || 'jigsaw-scanner';
const SESSION_COOKIE = 'jsession';
const LOGIN_COOKIE = 'jlogin';
const SESSION_DAYS = 90;
const LOGIN_MINUTES = 15;

let secret = null;
function sessionSecret() {
  if (secret) return secret;
  const file = path.join(dataDir(), 'session-secret');
  try {
    secret = fs.readFileSync(file);
  } catch {
    fs.writeFileSync(file, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' });
    secret = fs.readFileSync(file);
  }
  return secret;
}

const b64url = (buffer) => Buffer.from(buffer).toString('base64url');

function sign(data) {
  const body = b64url(JSON.stringify(data));
  const mac = crypto.createHmac('sha256', sessionSecret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function unsign(value) {
  const [body, mac] = String(value || '').split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', sessionSecret()).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return data.exp > Date.now() / 1000 ? data : null;
  } catch {
    return null;
  }
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name, value, { maxAge, path: cookiePath = '/', secure }) {
  return `${name}=${encodeURIComponent(value)}; Path=${cookiePath}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** The public origin of this app (the platform's proxy terminates TLS). */
function origin(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  const proto = req.headers['x-forwarded-proto']?.split(',')[0] || (local ? 'http' : 'https');
  return `${proto}://${host}`;
}

/** The signed-in user ({ sub, email, name }) or null. */
export function currentUser(req) {
  const session = unsign(cookies(req)[SESSION_COOKIE]);
  return session ? { sub: session.sub, email: session.email, name: session.name } : null;
}

/** Only same-site paths are allowed as the page to return to after signing in. */
function safeReturn(value) {
  const ret = String(value || '/');
  return /^\/(?!\/)[\w\-./?=&%]*$/.test(ret) ? ret : '/';
}

let discovery = null;
async function provider() {
  if (!discovery) {
    const response = await fetch(`${ISSUER}/.well-known/openid-configuration`);
    if (!response.ok) throw new Error(`OIDC discovery failed (${response.status})`);
    discovery = await response.json();
  }
  return discovery;
}

let jwks = { keys: [], fetched: 0 };
async function signingKey(kid) {
  const find = () => jwks.keys.find((k) => !kid || k.kid === kid);
  if (!find() || Date.now() - jwks.fetched > 3600e3) {
    const response = await fetch((await provider()).jwks_uri);
    if (!response.ok) throw new Error(`Could not load signing keys (${response.status})`);
    jwks = { keys: (await response.json()).keys || [], fetched: Date.now() };
  }
  const jwk = find();
  if (!jwk) throw new Error('Unknown signing key');
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

async function verifyIdToken(token, nonce) {
  const [header64, payload64, signature64] = String(token).split('.');
  const header = JSON.parse(Buffer.from(header64, 'base64url').toString('utf8'));
  if (header.alg !== 'RS256') throw new Error('Unexpected token algorithm');
  const valid = crypto.verify('RSA-SHA256', Buffer.from(`${header64}.${payload64}`), await signingKey(header.kid), Buffer.from(signature64, 'base64url'));
  if (!valid) throw new Error('Invalid token signature');
  const claims = JSON.parse(Buffer.from(payload64, 'base64url').toString('utf8'));
  const now = Date.now() / 1000;
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== (await provider()).issuer) throw new Error('Unexpected token issuer');
  if (!audience.includes(CLIENT_ID)) throw new Error('Token is for another app');
  if (!(claims.exp > now - 60)) throw new Error('Token expired');
  if (claims.nonce !== undefined && claims.nonce !== nonce) throw new Error('Token nonce mismatch');
  if (!claims.sub) throw new Error('Token has no subject');
  return claims;
}

function redirect(res, location, setCookies = []) {
  res.writeHead(302, { location, 'cache-control': 'no-store', 'set-cookie': setCookies });
  res.end();
}

/**
 * Handles /auth/* requests. `onSignIn(user)` runs after a successful sign-in.
 * @returns {Promise<boolean>} whether the request was handled
 */
export async function handleAuth(req, res, pathname, url, onSignIn) {
  const secure = origin(req).startsWith('https:');

  if (req.method === 'GET' && pathname === '/auth/login') {
    const verifier = b64url(crypto.randomBytes(32));
    const state = b64url(crypto.randomBytes(16));
    const nonce = b64url(crypto.randomBytes(16));
    const ret = safeReturn(url.searchParams.get('return'));
    const login = sign({ state, verifier, nonce, ret, exp: Math.floor(Date.now() / 1000) + LOGIN_MINUTES * 60 });
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: `${origin(req)}/auth/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    redirect(res, `${(await provider()).authorization_endpoint}?${params}`, [cookie(LOGIN_COOKIE, login, { maxAge: LOGIN_MINUTES * 60, path: '/auth', secure })]);
    return true;
  }

  if (req.method === 'GET' && pathname === '/auth/callback') {
    const clear = cookie(LOGIN_COOKIE, '', { maxAge: 0, path: '/auth', secure });
    const login = unsign(cookies(req)[LOGIN_COOKIE]);
    const fail = (message) => redirect(res, `/?signin_error=${encodeURIComponent(message)}`, [clear]);
    if (url.searchParams.get('error')) return fail(url.searchParams.get('error_description') || url.searchParams.get('error')), true;
    if (!login || login.state !== url.searchParams.get('state')) return fail('The sign-in took too long or was started in another browser. Please try again.'), true;
    try {
      const response = await fetch((await provider()).token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: url.searchParams.get('code') || '',
          redirect_uri: `${origin(req)}/auth/callback`,
          client_id: CLIENT_ID,
          code_verifier: login.verifier,
        }),
      });
      const tokens = await response.json().catch(() => ({}));
      if (!response.ok || !tokens.id_token) throw new Error(tokens.error_description || tokens.error || `token exchange failed (${response.status})`);
      const claims = await verifyIdToken(tokens.id_token, login.nonce);
      const user = { sub: String(claims.sub), email: claims.email || '', name: claims.name || claims.email || 'Signed in' };
      await onSignIn(user);
      const session = sign({ ...user, exp: Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400 });
      redirect(res, login.ret, [clear, cookie(SESSION_COOKIE, session, { maxAge: SESSION_DAYS * 86400, secure })]);
    } catch (error) {
      console.error('sign-in failed', error);
      fail(`Sign-in failed: ${error.message}`);
    }
    return true;
  }

  if (req.method === 'POST' && pathname === '/auth/logout') {
    res.writeHead(204, { 'set-cookie': cookie(SESSION_COOKIE, '', { maxAge: 0, secure }), 'cache-control': 'no-store' });
    res.end();
    return true;
  }

  return false;
}
