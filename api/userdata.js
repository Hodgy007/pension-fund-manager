import { dbConfigured, db, ensureSchema, getSessionUser, notConfigured } from './_db.js';

export const config = { api: { bodyParser: { sizeLimit: '4mb' } } };

// One jsonb blob per user holding all their private dashboard state
// (holdings, valuations, contributions, projection settings, ...).
export default async function handler(req, res) {
  if (!dbConfigured()) return notConfigured(res);
  await ensureSchema();
  const s = db();

  try {
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Not signed in.' });

    if (req.method === 'GET') {
      const rows = await s`SELECT data, updated_at FROM user_data WHERE user_id = ${user.id}`;
      return res.status(200).json({ data: rows[0]?.data ?? null, updatedAt: rows[0]?.updated_at ?? null });
    }

    if (req.method === 'POST') {
      const data = req.body && typeof req.body.data === 'object' && req.body.data !== null ? req.body.data : null;
      if (!data) return res.status(400).json({ error: 'Missing data' });
      await s`INSERT INTO user_data(user_id, data, updated_at)
              VALUES(${user.id}, ${JSON.stringify(data)}::jsonb, now())
              ON CONFLICT(user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('userdata error:', err);
    return res.status(500).json({ error: 'Server error — please try again.' });
  }
}
