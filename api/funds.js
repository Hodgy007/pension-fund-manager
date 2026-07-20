import { dbConfigured, db, ensureSchema, getSessionUser, notConfigured } from './_db.js';

// price series for a full fund set can be sizeable
export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

export default async function handler(req, res) {
  if (!dbConfigured()) return notConfigured(res);
  await ensureSchema();
  const s = db();

  try {
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in first.' });

    if (req.method === 'GET') {
      const funds = await s`SELECT name, rows, updated_at FROM funds ORDER BY name`;
      const factsheets = await s`SELECT name, data, updated_at FROM factsheets ORDER BY name`;
      return res.status(200).json({ funds, factsheets });
    }

    if (req.method === 'POST') {
      const funds = Array.isArray(req.body?.funds) ? req.body.funds.slice(0, 200) : [];
      const factsheets = Array.isArray(req.body?.factsheets) ? req.body.factsheets.slice(0, 200) : [];
      let nf = 0, ns = 0;
      for (const f of funds) {
        // rows arrive as [[epochMs, price], ...]
        if (!f || typeof f.name !== 'string' || !f.name.trim() || !Array.isArray(f.rows) || !f.rows.length) continue;
        await s`INSERT INTO funds(name, rows, updated_by, updated_at)
                VALUES(${f.name.slice(0, 300)}, ${JSON.stringify(f.rows)}::jsonb, ${user.id}, now())
                ON CONFLICT(name) DO UPDATE SET rows = EXCLUDED.rows, updated_by = EXCLUDED.updated_by, updated_at = now()`;
        nf++;
      }
      for (const fs of factsheets) {
        if (!fs || typeof fs.name !== 'string' || !fs.name.trim()) continue;
        await s`INSERT INTO factsheets(name, data, updated_by, updated_at)
                VALUES(${fs.name.slice(0, 300)}, ${JSON.stringify(fs)}::jsonb, ${user.id}, now())
                ON CONFLICT(name) DO UPDATE SET data = EXCLUDED.data, updated_by = EXCLUDED.updated_by, updated_at = now()`;
        ns++;
      }
      return res.status(200).json({ ok: true, funds: nf, factsheets: ns });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('funds error:', err);
    return res.status(500).json({ error: 'Server error — please try again.' });
  }
}
