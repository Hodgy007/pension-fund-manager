import { neon } from '@neondatabase/serverless';

// The Neon Vercel integration injects DATABASE_URL (older setups may use POSTGRES_URL)
const URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.NEON_DATABASE_URL;

export const dbConfigured = () => !!URL;

let sql = null;
export function db() {
  if (!URL) return null;
  if (!sql) sql = neon(URL);
  return sql;
}

// The app stores NO personal data and has NO accounts. The database holds only the
// shared, non-personal fund price library (funds + factsheets), open to anyone.
let schemaReady = null;
export async function ensureSchema() {
  const s = db();
  if (!s) return false;
  if (!schemaReady) schemaReady = (async () => {
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
    // AI-generated per-fund observations, keyed by fund name. Non-personal, shared.
    await s`CREATE TABLE IF NOT EXISTS observations(
      name text PRIMARY KEY,
      cards jsonb NOT NULL,
      as_of text,
      model text,
      updated_at timestamptz NOT NULL DEFAULT now())`;
    // accounts removed — drop the old user/session/personal tables so no emails,
    // password hashes or personal data remain in the database
    await s`DROP TABLE IF EXISTS user_data`;
    await s`DROP TABLE IF EXISTS sessions`;
    await s`DROP TABLE IF EXISTS users`;
  })();
  await schemaReady;
  return true;
}

export function notConfigured(res) {
  return res.status(503).json({
    error: 'db_not_configured',
    message: 'Database not connected yet. Add a Neon database to the Vercel project (Storage tab) and redeploy.',
  });
}
