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

// ---------------------------------------------------------------------------
// Annual statement reading. The template parser was written against the 2020
// "Pension Plan statement"; anything else must still load what it can, be
// flagged as partial, and never throw.
// ---------------------------------------------------------------------------

// build the {items:[{s,x,y,h}]} shape extractPdfPages() produces, one line per row
const pagesOf = (...lines) => [{ items: lines.map((s, i) => ({ s, x: 20, y: 800 - i * 12, h: 10 })) }];

const STATEMENT_2020 = pagesOf(
  'Your 2020 Pension Plan statement',
  'The total value of your Pension Savings Accounts at 1 July 2020 was: £3,510.99',
  'Between 1 July 2019 and 30 June 2020',
  'The contributions the Firm paid into your Pension Savings Account were £1,200.00',
  'The contributions you paid to your Pension Savings Account were £800.00',
  'Date of birth 12 March 1985',
  'Normal Pension Date 12 March 2050',
);

// a different provider, a different year, none of the wording the template parser knows
const STATEMENT_UNKNOWN = pagesOf(
  'Workplace Pension — your annual statement 2024',
  'Plan number 12345678',
  'Total value of your plan on 5 April 2024 £48,210.55',
  'Employer contributions paid in this year £2,400.00',
  'Your contributions paid in this year £1,800.00',
  'Transfer in from another pension £5,000.00',
  'Investment growth over the year £3,145.20',
  'Your selected retirement date 5 April 2050',
  'What your pension could be worth at retirement £210,000',
);

test('ukDate/anyDate read the date shapes statements use', () => {
  assert.equal(F.ukDate('1 July 2020'), '2020-07-01');
  assert.equal(F.ukDate('1 Jul 2020'), '2020-07-01');       // abbreviated months
  assert.equal(F.anyDate('as at 05/03/2024'), '2024-03-05'); // day-first, UK convention
  assert.equal(F.anyDate('2024-03-05'), '2024-03-05');
  assert.equal(F.anyDate('no date here'), null);
});

test('the 2020 template still parses in full (not flagged partial)', () => {
  const S = F.parseStatement(STATEMENT_2020);
  assert.ok(S, 'the known template must still parse');
  assert.equal(S.date, '2020-07-01');
  assert.equal(S.totalValue, 3510.99);
  assert.equal(S.employer, 1200);
  assert.equal(S.employee, 800);
  assert.equal(S.dob, '1985-03-12');
  assert.ok(!S.partial, 'a full parse is not partial');
  assert.equal(F.readStatement(STATEMENT_2020).partial, false);
});

test('an unrecognised statement layout is still detected as a statement', () => {
  assert.equal(F.parseStatement(STATEMENT_UNKNOWN), null, 'strict parser should not claim it');
  assert.equal(F.looksLikeStatement(STATEMENT_UNKNOWN[0].items.map(i => i.s).join(' ')), true);
});

test('an unrecognised statement loads the figures it can, flagged partial', () => {
  const S = F.parseStatementLoose(STATEMENT_UNKNOWN);
  assert.ok(S, 'best-effort read should produce a statement');
  assert.equal(S.partial, true);
  assert.equal(S.format, 'unrecognised');
  assert.equal(S.modelledYear, F.STMT_MODEL_YEAR);
  assert.equal(S.date, '2024-04-05');
  assert.equal(S.year, 2024);
  assert.equal(S.totalValue, 48210.55);
  assert.equal(S.employer, 2400);
  assert.equal(S.employee, 1800);
  assert.equal(S.transferIn, 5000);
  assert.equal(S.estAtNPD, 210000);
  assert.ok(Math.abs(S.growthStated - 3145.2) < 0.01);
  assert.equal(S.npd, '2050-04-05');
  assert.ok(Array.isArray(S.funds) && S.funds.length === 0, 'funds must exist so renderers stay safe');
  assert.ok(S.read.includes('pot value'), `read fields: ${S.read}`);
  assert.ok(S.missing.includes('date of birth'), `missing fields: ${S.missing}`);
});

test('readStatement reports a statement it cannot read at all, without throwing', () => {
  const R = F.readStatement(pagesOf(
    'Your annual pension statement',
    'Plan number 99887766',
    'Charges taken £12.40',
    'Please refer to the enclosed booklet for details of your plan',
  ));
  assert.ok(R, 'should be recognised as a statement');
  assert.equal(R.statement, null, 'nothing usable to store');
  assert.equal(R.partial, true);
  assert.ok(R.missing.length > 0);
});

test('readStatement leaves non-statements alone and survives junk', () => {
  const factsheet = pagesOf(
    'Pension Portfolio Two',
    'Fund Objective To provide long term growth',
    'Fund Features Invests in a mix of assets',
    'Unit Price 245.6p',
    'Cumulative Performance Fund 1.0% 2.0% 3.0% 4.0% 5.0%',
  );
  assert.equal(F.readStatement(factsheet), null, 'a factsheet is not a statement');
  assert.equal(F.readStatement(pagesOf('Invoice 12345', 'Amount due £45.00')), null);
  assert.equal(F.readStatement([]), null);
  assert.equal(F.parseStatementLoose(null), null);
  assert.equal(F.looksLikeStatement(''), false);
});

test('a text-only PDF is not loaded as a phantom factsheet', () => {
  assert.equal(F.parseFactsheet(STATEMENT_UNKNOWN), null,
    'a statement must never come through as a fund factsheet');
});

test('a partial re-read fills blanks but never overwrites a full parse', () => {
  const base = F.parseStatement(STATEMENT_2020);
  const merged = F.mergeStatement(base, {
    date: '2020-07-01', totalValue: 99999, transferIn: 250, partial: true, format: 'unrecognised',
  });
  assert.equal(merged.totalValue, 3510.99, 'known-good figure survives');
  assert.equal(merged.transferIn, 250, 'blank field is filled');
  assert.ok(!merged.partial, 'the merged year is not downgraded to partial');
});

test('partial statements survive the figures that drive the timeline', () => {
  const S = F.parseStatementLoose(STATEMENT_UNKNOWN);
  assert.equal(F.stmtPaidIn(S), 2400 + 1800 + 5000);
  assert.ok(Math.abs(F.stmtGrowth(S) - 3145.2) < 0.01);
  // a statement with nothing but a pot value must not produce a NaN anywhere
  const bare = { date: '2024-04-05', totalValue: 1000, partial: true, funds: [], plans: {} };
  assert.equal(F.stmtPaidIn(bare), 0);
  assert.equal(F.stmtGrowth(bare), null);
});
