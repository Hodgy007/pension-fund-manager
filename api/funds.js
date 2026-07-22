import { dbConfigured, db, ensureSchema, notConfigured } from './_db.js';

// price series for a full fund set can be sizeable
export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

// Open, no login: the fund price library is shared, non-personal market data.
export default async function handler(req, res) {
  if (!dbConfigured()) return notConfigured(res);
  await ensureSchema();
  const s = db();

  try {
    if (req.method === 'GET') {
      const funds = await s`SELECT name, rows, updated_at FROM funds ORDER BY name`;
      const rawFs = await s`SELECT name, data, updated_at FROM factsheets ORDER BY name`;
      // attach any AI observations so they arrive with the normal factsheet sync
      const obs = await s`SELECT name, cards FROM observations`;
      const obsMap = {};
      for (const o of obs) obsMap[o.name] = o.cards;
      const factsheets = rawFs.map((r) => ({
        ...r,
        data: { ...r.data, observations: obsMap[r.name] || (r.data && r.data.observations) || null },
      }));
      return res.status(200).json({ funds, factsheets });
    }

    if (req.method === 'POST') {
      const funds = Array.isArray(req.body?.funds) ? req.body.funds.slice(0, 200) : [];
      const factsheets = Array.isArray(req.body?.factsheets) ? req.body.factsheets.slice(0, 200) : [];
      // the write endpoint is open, so strip HTML-significant chars from stored names as
      // defense-in-depth against a stored-XSS payload in the shared library
      const clean = (v) => String(v).replace(/[<>]/g, '');
      let nf = 0, ns = 0;
      for (const f of funds) {
        // rows arrive as [[epochMs, price], ...]
        if (!f || typeof f.name !== 'string' || !f.name.trim() || !Array.isArray(f.rows) || !f.rows.length) continue;
        await s`INSERT INTO funds(name, rows, updated_at)
                VALUES(${clean(f.name).slice(0, 300)}, ${JSON.stringify(f.rows)}::jsonb, now())
                ON CONFLICT(name) DO UPDATE SET rows = EXCLUDED.rows, updated_at = now()`;
        nf++;
      }
      for (const fs of factsheets) {
        if (!fs || typeof fs.name !== 'string' || !fs.name.trim()) continue;
        await s`INSERT INTO factsheets(name, data, updated_at)
                VALUES(${clean(fs.name).slice(0, 300)}, ${JSON.stringify(fs)}::jsonb, now())
                ON CONFLICT(name) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`;
        ns++;
      }
      return res.status(200).json({ ok: true, funds: nf, factsheets: ns });
    }

    // no DELETE: the shared fund library is intentionally not clearable from the app
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('funds error:', err);
    return res.status(500).json({ error: 'Server error — please try again.' });
  }
}
