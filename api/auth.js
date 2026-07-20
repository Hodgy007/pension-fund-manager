import {
  dbConfigured, db, ensureSchema, hashPassword, verifyPassword,
  createSession, getSessionUser, destroySession, sessionCookie, notConfigured,
} from './_db.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
  if (!dbConfigured()) return notConfigured(res);
  await ensureSchema();
  const s = db();

  try {
    if (req.method === 'GET') {
      const user = await getSessionUser(req);
      return res.status(200).json({ user: user ? { id: user.id, email: user.email } : null });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { action } = req.body || {};
    const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 254);
    const password = String(req.body?.password || '').slice(0, 200);

    if (action === 'signup') {
      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
      if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
      const exists = await s`SELECT 1 FROM users WHERE email = ${email}`;
      if (exists.length) return res.status(409).json({ error: 'An account with that email already exists — sign in instead.' });
      const rows = await s`INSERT INTO users(email, pass_hash) VALUES(${email}, ${hashPassword(password)}) RETURNING id, email`;
      const token = await createSession(rows[0].id);
      res.setHeader('Set-Cookie', sessionCookie(token, 30 * 86400));
      return res.status(200).json({ user: rows[0] });
    }

    if (action === 'login') {
      const rows = await s`SELECT id, email, pass_hash FROM users WHERE email = ${email}`;
      if (!rows.length || !verifyPassword(password, rows[0].pass_hash)) {
        return res.status(401).json({ error: 'Wrong email or password.' });
      }
      const token = await createSession(rows[0].id);
      res.setHeader('Set-Cookie', sessionCookie(token, 30 * 86400));
      return res.status(200).json({ user: { id: rows[0].id, email: rows[0].email } });
    }

    if (action === 'logout') {
      await destroySession(req);
      res.setHeader('Set-Cookie', sessionCookie('', 0));
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('auth error:', err);
    return res.status(500).json({ error: 'Server error — please try again.' });
  }
}
