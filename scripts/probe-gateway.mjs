// One-off check that the AI Gateway key + model slug work, before deploying.
// Run:  AI_GATEWAY_API_KEY=your-key node scripts/probe-gateway.mjs
// (or put it in the shell env / .env.local and load that first)
import { generateText, gateway } from 'ai';

// The AI SDK gateway reads AI_GATEWAY_API_KEY; accept AI_GATEWAY_API as an alias.
if (!process.env.AI_GATEWAY_API_KEY && process.env.AI_GATEWAY_API) {
  process.env.AI_GATEWAY_API_KEY = process.env.AI_GATEWAY_API;
}

const MODEL = process.env.OBSERVE_MODEL || 'anthropic/claude-opus-4.6';

if (!process.env.AI_GATEWAY_API_KEY && !process.env.VERCEL_OIDC_TOKEN) {
  console.error('✗ No AI_GATEWAY_API_KEY (or VERCEL_OIDC_TOKEN) in the environment.');
  console.error('  The SDK looks for the variable named exactly AI_GATEWAY_API_KEY.');
  process.exit(1);
}

try {
  const models = await gateway.getAvailableModels();
  const anthropic = models.models
    .map((m) => m.id)
    .filter((id) => id.startsWith('anthropic/'));
  console.log('Available Anthropic slugs:\n  ' + anthropic.join('\n  '));
  console.log(`\nSlug in use: ${MODEL} — ${anthropic.includes(MODEL) ? '✓ resolves' : '✗ NOT in list, pick one above and set OBSERVE_MODEL'}`);
} catch (e) {
  console.error('✗ Could not list models:', e.message);
}

try {
  const { text, usage } = await generateText({
    model: MODEL,
    prompt: 'Reply with exactly: gateway ok',
  });
  console.log(`\n✓ Generation succeeded (${usage?.totalTokens ?? '?'} tokens): "${text.trim()}"`);
} catch (e) {
  console.error('\n✗ Generation failed:', e.statusCode ? `HTTP ${e.statusCode} — ` : '', e.message);
  process.exit(1);
}
