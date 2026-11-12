import crypto from 'node:crypto';
import { getSetting, setSetting } from './db.js';
import { parseCookies, clientIp } from './util.js';
import { SESSION_DAYS } from './config.js';

const COOKIE = 'hd_session';
const COOKIE_SHARE = 'hd_share_';
let secret = '';
let passwordHash = ''; // scrypt hash of the admin password

export function scryptHash(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, 32);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function scryptVerify(password, stored) {
  if (!stored) return false;
  const [scheme, saltHex, keyHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

export function initAuth() {
  secret = process.env.SESSION_SECRET || getSetting('session_secret') || '';
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    setSetting('session_secret', secret);
  }

  const envPassword = process.env.ADMIN_PASSWORD || '';
  if (envPassword) {
    passwordHash = scryptHash(envPassword);
  } else {
    passwordHash = getSetting('admin_password_hash') || '';
    if (!passwordHash) {
      const generated = crypto.randomBytes(9).toString('base64url');
      passwordHash = scryptHash(generated);
      setSetting('admin_password_hash', passwordHash);
      console.log(
        `\n  No ADMIN_PASSWORD set — generated one for you:\n\n      ${generated}\n\n` +
          `  (change it by setting ADMIN_PASSWORD in .env and restarting)\n`
      );
    }
  }
}

function signature(exp, version) {
  return crypto.createHmac('sha256', secret).update(`${exp}.${version}`).digest('base64url');
}

/** Sessions are bound to the current password, so changing it logs everyone out. */
function passwordVersion() {
  return sha256(passwordHash).slice(0, 16);
}

export function createSession() {
  const exp = Date.now() + SESSION_DAYS * 86400_000;
  const version = passwordVersion();
  return `${exp}.${version}.${signature(exp, version)}`;
}

export function sessionValid(token) {
  if (!token || typeof token !== 'string') return false;
  const [expRaw, version, sig] = token.split('.');
  if (!expRaw || !version || !sig) return false;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  if (version !== passwordVersion()) return false;
  const expected = signature(exp, version);
  if (expected.length !== sig.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

export function isAuthed(req) {
  return sessionValid(parseCookies(req.headers.cookie)[COOKIE]);
}

export function checkPassword(password) {
  return scryptVerify(password, passwordHash);
}

const sessionAttrs = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;

export function setSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(createSession())}; ${sessionAttrs}`);
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/* ---------- share passwords ---------- */

export function shareCookieName(token) {
  return COOKIE_SHARE + token;
}

function shareSig(token) {
  return crypto.createHmac('sha256', secret).update(`share:${token}`).digest('base64url');
}

export function setShareCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    `${shareCookieName(token)}=${shareSig(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`
  );
}

export function hasShareCookie(req, token) {
  const value = parseCookies(req.headers.cookie)[shareCookieName(token)];
  if (!value) return false;
  const expected = shareSig(token);
  return value.length === expected.length && crypto.timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}

/* ---------- login throttling ---------- */

const attempts = new Map();

export function throttleLogin(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + 15 * 60_000 });
    return { ok: true };
  }
  entry.count += 1;
  if (entry.count > 12) {
    return { ok: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }
  return { ok: true };
}

export function clearLoginAttempts(req) {
  attempts.delete(clientIp(req));
}
