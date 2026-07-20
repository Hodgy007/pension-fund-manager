import { neon } from '@neondatabase/serverless';
import crypto from 'node:crypto';

// The Neon Vercel integration injects DATABASE_URL (older setups may use POSTGRES_URL)
const URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.NEON_DATABASE_URL;

export const dbConfigured = () => !!URL;

let sql = null;
export function db() {
  if (!URL) return null;
  if (!sql) sql = neon(URL);
  return sql;
}

// Lazily create the schema once per cold start. CREATE TABLE IF NOT EXISTS keeps
// this idempotent so no separate migration runner is needed for a schema this small.
let schemaReady = null;
export async function ensureSchema() {
  const s = db();
  if (!s) return false;
  if (!schemaReady) schemaReady = (async () => {
    await s`CREATE TABLE IF NOT EXISTS users(
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      email text UNIQUE NOT NULL,
      pass_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now())`;
    await s`CREATE TABLE IF NOT EXISTS sessions(
      token text PRIMARY KEY,
      user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL)`;
    await s`CREATE TABLE IF NOT EXISTS funds(
      name text PRIMARY KEY,
      rows jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by bigint)`;
    await s`CREATE TABLE IF NOT EXISTS factsheets(
      name text PRIMARY KEY,
      data jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by bigint)`;
    await s`CREATE TABLE IF NOT EXISTS user_data(
      user_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now())`;
  })();
  await schemaReady;
  return true;
}

// ---- passwords (scrypt, per-user random salt, constant-time compare) ----
const KEYLEN = 64;
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, KEYLEN).toString('hex');
  return `s1:${salt}:${hash}`;
}
export function verifyPassword(pw, stored) {
  const [v, salt, hash] = String(stored || '').split(':');
  if (v !== 's1' || !salt || !hash) return false;
  const calc = crypto.scryptSync(pw, salt, KEYLEN);
  const orig = Buffer.from(hash, 'hex');
  return calc.length === orig.length && crypto.timingSafeEqual(calc, orig);
}

// ---- sessions (opaque random token in httpOnly cookie, row in sessions table) ----
export function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
export function sessionCookie(token, maxAgeSec) {
  return `pfm_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}
export async function createSession(userId) {
  const s = db();
  const token = crypto.randomBytes(32).toString('hex');
  await s`DELETE FROM sessions WHERE expires_at < now()`;
  await s`INSERT INTO sessions(token, user_id, expires_at) VALUES(${token}, ${userId}, now() + interval '30 days')`;
  return token;
}
export async function getSessionUser(req) {
  const s = db();
  if (!s) return null;
  const token = parseCookies(req).pfm_session;
  if (!token) return null;
  const rows = await s`SELECT u.id, u.email FROM sessions se JOIN users u ON u.id = se.user_id
                       WHERE se.token = ${token} AND se.expires_at > now()`;
  return rows[0] || null;
}
export async function destroySession(req) {
  const s = db();
  if (!s) return;
  const token = parseCookies(req).pfm_session;
  if (token) await s`DELETE FROM sessions WHERE token = ${token}`;
}

export function notConfigured(res) {
  return res.status(503).json({
    error: 'db_not_configured',
    message: 'Database not connected yet. Add a Neon database to the Vercel project (Storage tab) and redeploy.',
  });
}
