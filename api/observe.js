import { generateObject } from 'ai';
import { z } from 'zod';
import { put, list } from '@vercel/blob';
import { db, ensureSchema, dbConfigured } from './_db.js';

// Per-fund AI observations. Input is PUBLIC fund data only (extracted from the fund's own
// factsheet) — never the user's personal holdings, weights or £ amounts, which stay on their
// device. Results are persisted (shared) in the Neon database when configured, so once a fund
// is generated every visitor sees it instantly; Vercel Blob is used as a fallback store.
// Pass { regenerate: true } to force a fresh generation.

// The AI SDK gateway reads AI_GATEWAY_API_KEY; accept AI_GATEWAY_API as an alias.
if (!process.env.AI_GATEWAY_API_KEY && process.env.AI_GATEWAY_API) {
  process.env.AI_GATEWAY_API_KEY = process.env.AI_GATEWAY_API;
}

export const config = { maxDuration: 30 };

// Bump when the prompt/schema changes so stale cached cards are ignored.
const CACHE_VERSION = 'v1';
const MODEL = process.env.OBSERVE_MODEL || 'anthropic/claude-opus-4.6';

const CardsSchema = z.object({
  cards: z
    .array(
      z.object({
        heading: z.string().describe('Short observation heading, max ~7 words.'),
        body: z.string().describe('1–3 plain-English sentences referencing the actual numbers.'),
      })
    )
    .min(3)
    .max(5),
});

const SYSTEM = `You are a factual analyst writing observation cards about a SINGLE investment fund for an information-only UK pension dashboard. You are given structured data extracted from the fund's own factsheet. Write 3–5 short cards that help a non-expert understand what this fund is and why its performance looks the way it does.

STRICT RULES — follow all of them:
- Use ONLY the data provided. Never introduce outside facts, prices, market events, news or figures that are not in the input. If there is not enough data for a point, leave it out.
- This is INFORMATION, NOT financial advice. Never tell the reader to buy, sell, switch, hold, add, reduce, or move anything, and never imply one fund is a better or worse choice for them personally.
- No predictions or forecasts. Describe only what the data shows about the past.
- Explain causes cautiously and only where the data supports it (e.g. asset mix vs the type of benchmark). Use hedged language such as "this likely reflects", "consistent with", "which may explain".
- Plain UK English. Reference the actual numbers. Gloss any jargon in a few words.
- Each heading max ~7 words; each body 1–3 sentences. No markdown, no bullet points inside a card.`;

const cleanName = (name) => String(name || 'fund').replace(/[<>]/g, '').slice(0, 300);

function blobKey(name, asOf) {
  const slug = String(name || 'fund').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  const when = String(asOf || 'na').replace(/[^0-9a-z]+/gi, '');
  return `observations/${CACHE_VERSION}-${slug}-${when}.json`;
}

// Read stored cards for a fund. DB first (shared), Blob as fallback. Returns null on miss
// or when the stored factsheet date differs from the one requested (so a newer factsheet
// regenerates rather than serving stale cards).
async function readStore(name, asOf) {
  if (dbConfigured()) {
    try {
      await ensureSchema();
      const s = db();
      const rows = await s`SELECT cards, as_of FROM observations WHERE name = ${cleanName(name)}`;
      if (rows[0] && (!asOf || !rows[0].as_of || rows[0].as_of === asOf)) return rows[0].cards;
      return null;
    } catch (e) {
      console.error('obs db read failed:', e);
    }
  }
  try {
    const { blobs } = await list({ prefix: blobKey(name, asOf), limit: 1 });
    if (!blobs.length) return null;
    const res = await fetch(blobs[0].url, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.cards) ? data.cards : null;
  } catch {
    return null;
  }
}

async function writeStore(name, asOf, cards) {
  if (dbConfigured()) {
    try {
      await ensureSchema();
      const s = db();
      await s`INSERT INTO observations(name, cards, as_of, model, updated_at)
              VALUES(${cleanName(name)}, ${JSON.stringify(cards)}::jsonb, ${asOf || null}, ${MODEL}, now())
              ON CONFLICT(name) DO UPDATE SET cards = EXCLUDED.cards, as_of = EXCLUDED.as_of, model = EXCLUDED.model, updated_at = now()`;
      return;
    } catch (e) {
      console.error('obs db write failed:', e);
    }
  }
  try {
    await put(blobKey(name, asOf), JSON.stringify({ cards, generatedAt: new Date().toISOString() }), {
      access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json',
    });
  } catch {
    /* best-effort */
  }
}

// Keep only the public factsheet fields — defends against the client sending anything personal.
function publicFund(b) {
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  const list_ = (arr, keys) =>
    Array.isArray(arr)
      ? arr.slice(0, 15).map((x) => {
          const o = {};
          for (const k of keys) if (x && x[k] != null) o[k] = x[k];
          return o;
        })
      : [];
  return {
    name: String(b.name || '').slice(0, 200),
    objective: String(b.objective || '').slice(0, 800),
    features: String(b.features || '').slice(0, 800),
    ocf: num(b.ocf),
    unitPrice: num(b.unitPrice),
    launch: b.launch || null,
    asOf: b.asOf || null,
    benchmarkName: String(b.benchmarkName || '').slice(0, 200),
    holdings: list_(b.holdings, ['name', 'weight']),
    assetSplit: list_(b.assetSplit, ['name', 'pct']),
    geoSplit: list_(b.geoSplit, ['name', 'pct']),
    cum: b.cum && Array.isArray(b.cum.fund) ? b.cum : null,
    ann: b.ann && Array.isArray(b.ann.fund) ? b.ann : null,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  if (!body.name) {
    return res.status(400).json({ error: 'Missing fund name' });
  }

  const fund = publicFund(body);
  const regenerate = !!body.regenerate;

  // 1. Serve stored cards unless a fresh generation was explicitly requested.
  if (!regenerate) {
    const stored = await readStore(fund.name, fund.asOf);
    if (stored) return res.status(200).json({ cards: stored, cached: true });
  }

  // 2. Generate.
  try {
    const { object } = await generateObject({
      model: MODEL,
      schema: CardsSchema,
      system: SYSTEM,
      temperature: 0.2,
      prompt:
        'Factsheet data for one fund (JSON). Write the observation cards.\n\n' +
        JSON.stringify(fund, null, 2),
      providerOptions: {
        gateway: {
          tags: ['feature:fund-observations'],
          // if the primary model (OBSERVE_MODEL) is unavailable on the gateway, fall back rather than fail
          models: ['anthropic/claude-sonnet-4.6', 'anthropic/claude-haiku-4.5'],
        },
      },
    });

    const cards = object.cards.slice(0, 5);
    await writeStore(fund.name, fund.asOf, cards);
    return res.status(200).json({ cards, cached: false });
  } catch (error) {
    console.error('observe error:', error);
    const status =
      error && typeof error.statusCode === 'number' ? error.statusCode : 502;
    return res.status(status).json({
      error: 'Could not generate observations',
      details: error && error.message ? error.message : String(error),
    });
  }
}
