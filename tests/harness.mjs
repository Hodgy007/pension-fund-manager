// Loads the real inline application script from index.html into a sandboxed
// context (DOM/network stubbed) so the pure financial functions can be unit
// tested against the exact code that ships — no copy/paste, no drift.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(here, '..', 'index.html');

export function extractInlineScript() {
  const html = readFileSync(htmlPath, 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (!scripts.length) throw new Error('no inline <script> found in index.html');
  // the application script is the last inline (non-src) <script> block
  return scripts[scripts.length - 1][1];
}

// A permissive proxy that is callable, constructable and answers any property
// access with itself — lets top-level DOM/event-wiring code run without throwing.
function makeProxy() {
  const fn = function () {};
  const p = new Proxy(fn, {
    get: () => p,
    apply: () => p,
    construct: () => p,
    set: () => true,
  });
  return p;
}

// Compiles the inline script (throws on syntax error) and returns its testable
// exports plus a setter to inject the mutable globals the functions read.
export function loadApp() {
  const script = extractInlineScript();
  const proxy = makeProxy();
  const localStorageStub = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

  const ctx = {
    document: proxy, window: proxy, localStorage: localStorageStub,
    navigator: proxy, XLSX: proxy, JSZip: proxy, pdfjsLib: undefined,
    innerWidth: 1000, innerHeight: 800, confirm: () => false, alert: () => {},
    Blob: proxy, URL: proxy, setTimeout, clearTimeout, console,
    Math, Date, JSON, RegExp, Number, String, Object, Array, Set, Map,
    Float64Array, isFinite, isNaN, parseFloat, parseInt,
  };
  ctx.globalThis = ctx;

  const exportNames = [
    'irr', 'pctile', 'niceStep', 'incomeTax', 'cat', 'parseDate', 'normName',
    'cleanName', 'gaussian', 'cleanValuations', 'cleanContributions',
    'monthlyFlows', 'effectiveContributions', 'computeValuations', 'latestValue', 'TAX',
  ];

  const epilogue = `
    globalThis.__exports = { ${exportNames.join(', ')} };
    globalThis.__set = (o) => {
      if ('VALUATIONS' in o) VALUATIONS = o.VALUATIONS;
      if ('CONTRIBUTIONS' in o) CONTRIBUTIONS = o.CONTRIBUTIONS;
      if ('MONTHLY' in o) MONTHLY = o.MONTHLY;
      if ('FUNDS' in o) FUNDS = o.FUNDS;
    };`;

  vm.createContext(ctx);
  // new vm.Script throws on syntax errors — this is also our syntax gate.
  new vm.Script(script + epilogue, { filename: 'index.inline.js' }).runInContext(ctx);
  return { exports: ctx.__exports, set: ctx.__set };
}
