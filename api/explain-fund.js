import { generateObject } from 'ai';
import { z } from 'zod';
import { put, list } from '@vercel/blob';

// Plain-language explainer for an UNDERLYING fund we only know by name (e.g. a fund
// held inside the user's pension fund). Unlike api/observe.js — which reasons ONLY over
// a supplied factsheet — this endpoint uses the model's general knowledge, so it is
// heavily hedged: general/typical terms only, never live holdings, prices, performance
// or advice. Results are cached per fund name.

// The AI SDK gateway reads AI_GATEWAY_API_KEY; accept AI_GATEWAY_API as an alias.
if (!process.env.AI_GATEWAY_API_KEY && process.env.AI_GATEWAY_API) {
  process.env.AI_GATEWAY_API_KEY = process.env.AI_GATEWAY_API;
}

export const config = { maxDuration: 30 };

const CACHE_VERSION = 'v1';
const MODEL = process.env.OBSERVE_MODEL || 'anthropic/claude-opus-4.6';

const Schema = z.object({
  summary: z.string().describe('1–2 plain sentences: what this fund is.'),
  assetClass: z.string().describe('Short label, e.g. "Absolute return / multi-asset".'),
  madeOf: z
    .array(z.string())
    .min(2)
    .max(6)
    .describe('2–6 short items describing the kinds of assets/holdings it TYPICALLY invests in.'),
  strategy: z.string().describe('1–2 sentences on its general approach.'),
  confident: z
    .boolean()
    .describe('True only if you are confident which specific named fund this is; false if you are describing the general category its name implies.'),
});

const SYSTEM = `You describe a named investment fund for a UK pension dashboard, to help a non-expert understand roughly what it is and what it typically invests in. You are given only the fund's NAME (and maybe a broad asset class). Use your general knowledge of this fund, or — if unsure which fund it is — of funds of this type.

STRICT RULES:
- This is GENERAL, POSSIBLY-OUTDATED background — NOT live data and NOT from a factsheet. Never state current holdings, weights, prices, yields or performance figures as fact. Speak only in typical/general terms ("typically holds", "aims to").
- If you are not confident the named fund exists or which one it is, set confident=false and describe the general category its name implies. NEVER invent a specific holding, manager, or number.
- No performance, no returns, no forecasts.
- This is information, NOT advice. Never suggest buying, selling, switching, or say it is good/bad for the reader.
- Plain UK English, concise.`;

function cacheKey(name) {
  const slug = String(name || 'fund')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
  return `fund-explain/${CACHE_VERSION}-${slug}.json`;
}

async function readCache(key) {
  try {
    const { blobs } = await list({ prefix: key, limit: 1 });
    if (!blobs.length) return null;
    const res = await fetch(blobs[0].url, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function writeCache(key, data) {
  try {
    await put(key, JSON.stringify(data), {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/json',
    });
  } catch {
    /* best-effort */
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const name = String(body.name || '').slice(0, 200).trim();
  const hintClass = String(body.assetClass || '').slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Missing fund name' });

  const key = cacheKey(name);
  const cached = await readCache(key);
  if (cached) return res.status(200).json({ ...cached, cached: true });

  try {
    const { object } = await generateObject({
      model: MODEL,
      schema: Schema,
      system: SYSTEM,
      temperature: 0.2,
      prompt:
        `Fund name: ${name}` +
        (hintClass ? `\nBroad asset class inferred from the name: ${hintClass}` : '') +
        `\n\nDescribe this fund per the rules.`,
      providerOptions: {
        gateway: {
          tags: ['feature:fund-explain'],
          models: ['anthropic/claude-sonnet-4.6', 'anthropic/claude-haiku-4.5'],
        },
      },
    });

    await writeCache(key, object);
    return res.status(200).json({ ...object, cached: false });
  } catch (error) {
    console.error('explain-fund error:', error);
    const status = error && typeof error.statusCode === 'number' ? error.statusCode : 502;
    return res.status(status).json({
      error: 'Could not explain this fund',
      details: error && error.message ? error.message : String(error),
    });
  }
}
