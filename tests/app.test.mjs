import test from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

// loadApp() also compiles the inline script — if it has a syntax error (e.g. the
// smart-quote outage), this throws and the whole suite fails fast.
const app = loadApp();
const F = app.exports;

test('inline script compiles and exports the financial functions', () => {
  for (const name of ['irr', 'pctile', 'niceStep', 'incomeTax', 'computeValuations']) {
    assert.equal(typeof F[name], 'function', `${name} should be a function`);
  }
});

test('pctile returns correct percentiles', () => {
  const a = [1, 2, 3, 4, 5];
  assert.equal(F.pctile(a, 0), 1);
  assert.equal(F.pctile(a, 0.5), 3);
  assert.equal(F.pctile(a, 1), 5);
  assert.equal(F.pctile(a, 0.25), 2);
});

test('niceStep produces sensible round steps', () => {
  assert.ok(F.niceStep(100) > 0);
  assert.equal(F.niceStep(60), 10);   // raw 10 -> 10
  assert.equal(F.niceStep(6), 1);     // raw 1 -> 1
});

test('irr solves a simple doubling over one year', () => {
  // -100 now, +200 in a year  => 100% IRR
  const r = F.irr([{ t: 0, cf: -100 }, { t: 1, cf: 200 }]);
  assert.ok(Math.abs(r - 1) < 1e-3, `expected ~1.0, got ${r}`);
});

test('irr returns ~0 for a flat, no-growth cashflow', () => {
  const r = F.irr([{ t: 0, cf: -100 }, { t: 1, cf: 100 }]);
  assert.ok(Math.abs(r) < 1e-3, `expected ~0, got ${r}`);
});

test('cat classifies fund names into asset classes', () => {
  assert.equal(F.cat('Global Equity Fund'), 'Equity');
  assert.equal(F.cat('UK Corporate Bond'), 'Bonds/Credit');
  assert.equal(F.cat('Cash Fund'), 'Cash');
  assert.equal(F.cat('Property Fund'), 'Property');
});

test('normName normalises for matching', () => {
  assert.equal(F.normName('  BlackRock  Over-15Y!! '), 'blackrock over 15y');
  assert.equal(F.normName('A_B-C'), 'a b c');
});

test('parseDate handles UK dd/mm/yyyy and ISO', () => {
  const d = F.parseDate('05/03/2024');
  assert.equal(d.getFullYear(), 2024);
  assert.equal(d.getMonth(), 2); // March (0-based)
  assert.equal(d.getDate(), 5);
  assert.ok(!isNaN(F.parseDate('2024-03-05')));
  assert.equal(F.parseDate('not a date'), null);
});

test('gaussian returns finite numbers roughly centred on 0', () => {
  let sum = 0;
  const N = 5000;
  for (let i = 0; i < N; i++) { const g = F.gaussian(); assert.ok(Number.isFinite(g)); sum += g; }
  assert.ok(Math.abs(sum / N) < 0.1, 'mean should be near 0');
});

test('incomeTax: no tax below the personal allowance', () => {
  assert.equal(F.incomeTax(10000), 0);
  assert.equal(F.incomeTax(0), 0);
});

test('incomeTax: basic-rate band taxed at 20%', () => {
  // £20,000 gross: (20000 - 12570) * 20% = 1486
  assert.ok(Math.abs(F.incomeTax(20000) - 1486) < 1, F.incomeTax(20000));
});

test('incomeTax: personal allowance tapers away above £100k', () => {
  // at £125,140 the personal allowance is fully withdrawn
  const justUnder = F.incomeTax(99000);
  const taper = F.incomeTax(120000);
  assert.ok(taper > justUnder, 'tax should rise across the taper zone');
});

test('computeValuations: cumulative and annualised on a clean 2-point series', () => {
  app.set({ VALUATIONS: [{ date: '2020-01-01', value: 10000 }, { date: '2021-01-01', value: 12000 }], CONTRIBUTIONS: [], MONTHLY: 0 });
  const r = F.computeValuations();
  assert.ok(r, 'should produce a result');
  assert.ok(Math.abs(r.cum - 20) < 0.5, `cumulative ~20%, got ${r.cum}`);
  assert.ok(Math.abs(r.ann - 20) < 1.0, `annualised ~20%, got ${r.ann}`);
  assert.equal(r.hasFlows, false);
});

test('computeValuations: contributions are separated from investment growth', () => {
  // start 10k, end 13k, but 2k was paid in -> only 1k is growth
  app.set({
    VALUATIONS: [{ date: '2020-01-01', value: 10000 }, { date: '2021-01-01', value: 13000 }],
    CONTRIBUTIONS: [{ date: '2020-06-01', amount: 2000 }], MONTHLY: 0,
  });
  const r = F.computeValuations();
  assert.equal(r.hasFlows, true);
  assert.ok(Math.abs(r.paidIn - 2000) < 1, `paidIn 2000, got ${r.paidIn}`);
  assert.ok(Math.abs(r.growthAbs - 1000) < 1, `growth 1000, got ${r.growthAbs}`);
  assert.ok(r.mwr != null && r.mwr > 0, 'money-weighted return should be positive');
});

test('monthlyFlows: generates one flow per month between first and last value', () => {
  app.set({ VALUATIONS: [{ date: '2020-01-15', value: 10000 }, { date: '2020-04-15', value: 11000 }], CONTRIBUTIONS: [], MONTHLY: 100 });
  const flows = F.monthlyFlows();
  assert.ok(flows.length >= 2 && flows.length <= 3, `expected ~2-3 monthly flows, got ${flows.length}`);
  assert.ok(flows.every(f => f.amount === 100));
});

test('monthlyFlows: no month-end date drift (31st clamps, no Mar 3)', () => {
  app.set({ VALUATIONS: [{ date: '2021-01-31', value: 10000 }, { date: '2021-06-30', value: 11000 }], CONTRIBUTIONS: [], MONTHLY: 50 });
  const flows = F.monthlyFlows();
  // every generated date must be a valid calendar date and never spill into the next month
  for (const f of flows) {
    const [y, m, d] = f.date.split('-').map(Number);
    const reparsed = new Date(y, m - 1, d);
    assert.equal(reparsed.getMonth(), m - 1, `date ${f.date} drifted into another month`);
  }
  // Feb should clamp to the 28th, not roll to Mar 3
  assert.ok(flows.some(f => f.date === '2021-02-28'), `expected a clamped 2021-02-28, got ${flows.map(f => f.date).join(', ')}`);
});

test('computeValuations: returns null with fewer than two recorded values', () => {
  app.set({ VALUATIONS: [{ date: '2020-01-01', value: 10000 }], CONTRIBUTIONS: [], MONTHLY: 0 });
  assert.equal(F.computeValuations(), null);
});

test('periodsPerYear: daily price data recovers ~252', () => {
  // a year of business-day-ish dates (skip weekends) ~ 261 points
  const days = [];
  let d = new Date('2021-01-01');
  while (d < new Date('2022-01-01')) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) days.push(new Date(d));
    d = new Date(d.getTime() + 864e5);
  }
  const ppy = F.periodsPerYear(days);
  assert.ok(ppy > 230 && ppy < 280, `daily data should annualise ~252, got ${ppy}`);
});

test('periodsPerYear: weekly data ~52, monthly ~12', () => {
  const weekly = Array.from({ length: 53 }, (_, i) => new Date(2021, 0, 1 + i * 7));
  const monthly = Array.from({ length: 13 }, (_, i) => new Date(2021, i, 1));
  assert.ok(Math.abs(F.periodsPerYear(weekly) - 52) < 4, F.periodsPerYear(weekly));
  assert.ok(Math.abs(F.periodsPerYear(monthly) - 12) < 1.5, F.periodsPerYear(monthly));
});

test('periodsPerYear: falls back to 252 on degenerate input', () => {
  assert.equal(F.periodsPerYear([]), 252);
  assert.equal(F.periodsPerYear([new Date()]), 252);
});
