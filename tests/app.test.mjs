import test from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

// loadApp() also compiles the inline script — if it has a syntax error (e.g. the
// smart-quote outage), this throws and the whole suite fails fast.
const app = loadApp();
const F = app.exports;
const bytes = s => new Uint8Array(Buffer.from(s, 'utf8')).buffer;

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

// ---------------------------------------------------------------------------
// Price-sheet reading. Runs against the vendored SheetJS the page actually ships.
// ---------------------------------------------------------------------------

test('parseWorkbook reads a price sheet into dated rows', () => {
  assert.ok(app.xlsxLoaded, 'vendored xlsx must load into the sandbox');
  const r = F.parseWorkbook('BlackRock World Fund.csv', bytes('Price,Date\n100.5,01/03/2024\n101.25,15/03/2024\n'));
  assert.ok(r, 'should parse');
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].p, 100.5);
  assert.equal(r.name, 'BlackRock World Fund', 'the file extension is not part of the fund name');
});

test('parseWorkbook reads csv dates day-first, not US month-first', () => {
  // "01/03/2024" is 1 March in every UK download. Read US-first it silently becomes
  // 3 January — and only for days 1-12, so a price history bends without ever erroring.
  const r = F.parseWorkbook('fund.csv', bytes('Price,Date\n100.5,01/03/2024\n101.25,15/03/2024\n'));
  const [a, b] = r.rows;
  assert.equal(a.d.getMonth(), 2, `expected March, got month ${a.d.getMonth()}`);
  assert.equal(a.d.getDate(), 1);
  assert.equal(b.d.getMonth(), 2);
  assert.equal(b.d.getDate(), 15);
  assert.ok(a.d < b.d, 'rows must come back in date order');
});

test('parseWorkbook returns null when there are no usable rows', () => {
  assert.equal(F.parseWorkbook('empty.csv', bytes('Price,Date\n')), null);
  assert.equal(F.parseWorkbook('junk.csv', bytes('nothing,useful\nhere,either\n')), null);
});

test('mergeFundRows unions histories instead of replacing them', () => {
  const older = [{ d: new Date('2023-01-02'), p: 90 }, { d: new Date('2023-01-03'), p: 91 }];
  const newer = [{ d: new Date('2023-01-03'), p: 99 }, { d: new Date('2024-01-02'), p: 120 }];
  const m = F.mergeFundRows(older, newer);
  assert.equal(m.length, 3, 'overlapping date merges, it does not duplicate');
  assert.equal(m[1].p, 99, 'the newer upload wins on an overlapping date');
  assert.equal(m[2].p, 120);
  assert.ok(m[0].d < m[1].d && m[1].d < m[2].d, 'sorted by date');
});

test('parseFactsheet pulls charges and holdings out of a factsheet page', () => {
  // the right-hand column is positional — x>180 with section headers above each block
  const items = [
    { s: 'Global Equity Fund', x: 20, y: 800, h: 16 },
    { s: 'Fund Objective To track global developed markets Fund Features Passive Fund Information', x: 20, y: 770, h: 9 },
    { s: 'Unit Price 245.6p', x: 20, y: 750, h: 9 },
    { s: 'Yearly Fund Charges 0.55 %', x: 20, y: 730, h: 9 },
    { s: 'Fund Holdings', x: 200, y: 700, h: 9 },
    { s: 'Apple Inc 5.20%', x: 200, y: 685, h: 9 },
    { s: 'Microsoft Corp 4.10%', x: 200, y: 670, h: 9 },
    { s: 'Asset Split as at 31/03/2024', x: 200, y: 650, h: 9 },
    { s: 'Equities 98.00%', x: 200, y: 635, h: 9 },
  ];
  const fs = F.parseFactsheet([{ items }]);
  assert.ok(fs, 'should parse as a factsheet');
  assert.equal(fs.name, 'Global Equity Fund');
  assert.equal(fs.ocf, 0.55);
  assert.equal(fs.unitPrice, 245.6);
  assert.equal(fs.holdings.length, 2);
  assert.equal(fs.holdings[0].name, 'Apple Inc');
  assert.equal(fs.holdings[0].weight, 5.2);
  assert.equal(fs.assetSplit[0].pct, 98);
});

test('parseFactsheet refuses a PDF with no factsheet fields in it', () => {
  const items = [{ s: 'Some Letter From Your Provider', x: 20, y: 800, h: 16 },
                 { s: 'We are writing to let you know about a change.', x: 20, y: 780, h: 9 }];
  assert.equal(F.parseFactsheet([{ items }]), null, 'a title is not a factsheet');
});

// ---------------------------------------------------------------------------
// Projection charge basis
// ---------------------------------------------------------------------------

const projInputs = { age: 40, ret: 67, pot: 100000, otherPots: 0, mon: 500, basis: 'gross',
  rate: 20, retn: 5, vol: 12, esc: 0, cpi: 2.5, aa: 60000, tgt: 0, real: true, wr: 4, other: 0 };

test('detPot compounds deterministically and falls with the rate', () => {
  const hi = F.detPot(projInputs, 5), lo = F.detPot(projInputs, 4.45);
  assert.ok(hi > 0 && lo > 0);
  assert.ok(lo < hi, 'a lower return must produce a smaller pot');
  assert.equal(F.detPot(projInputs, 5), hi, 'same inputs give the same answer every time');
  assert.equal(F.detPot({ ...projInputs, ret: 30 }, 5), null, 'retiring before you start is not a projection');
});

test('deducting charges lowers the projected pot', () => {
  const gross = F.projectMC({ ...projInputs, chgPct: 0 });
  const net = F.projectMC({ ...projInputs, chgPct: 0.55 });
  assert.equal(gross.retnNet, 5);
  assert.ok(Math.abs(net.retnNet - 4.45) < 1e-9, `expected 4.45%, got ${net.retnNet}`);
  // the simulation is random, so compare the deterministic equivalent for a stable assertion
  assert.ok(F.detPot(projInputs, net.retnNet) < F.detPot(projInputs, gross.retnNet));
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


// ---------------------------------------------------------------------------
// Real statement layouts, as pdf.js extracts them from the shipped PDFs.
//
// The pre-2023 booklet prints the year's figures into a template that arrives
// UNFILLED in the text layer: the English label is followed by a placeholder
// like "<AR ERREG Conts in Yr>", while the real filled value is drawn beside it
// in a subsetted font that extracts as gibberish. Left alone, a label reaches
// past its own placeholder and captures a different row's figure.
// ---------------------------------------------------------------------------

// Runs of the subsetted font, as pdf.js hands them over. Written as escapes because they
// are unprintable noise, and one of them carries invisible control characters.
const FONT_NOISE = '\u00b2\u00af\u00b9\u00b8\u00be\u00bc\u00b3\u00ac\u00bf\u00be\u00b3\u00b9\u00b8\u00bd';          // the encoded form of "he contributions"
const NOISE_WITH_CONTROLS = '\u00ab\u00be\u0003\u0230\u0003';  // "at 1", with U+0003 between the glyphs
const FUND_NOISE = '\u00be\u00b3\u00c0\u00af' + ' Active Diversified ' + '\u00b6\u00b9\u00ac\u00ab\u00b6';

const BOOKLET_2022 = pagesOf(
  'Emilia, this is your 2022 Pension Plan statement',
  'The total value of your Pension Savings Account at 1 July 2022 was: £7,466.14',
  'How Your Pension Savings THE FIRM’S CONTRIBUTIONS Account Developed Between',
  'The contributions the Firm paid to the Main Plan <AR ERREG Conts in Yr> 1 July 2021 and 1 July 2022',
  'YOUR CONTRIBUTIONS The contributions you paid to the Main Plan <AN EEREG Conts in Yr>',
  'The Additional Voluntary Contributions you paid <AP EETOP Conts in Yr> to the Top-Up Plan',
  'THE FIRM’S CONTRIBUTIONS ' + FONT_NOISE + ' <AJ BONWAV Conts in Yr> £6,357.05',
  'The amount you transferred into the Top-Up Plan YOUR CONTRIBUTIONS',
  '<AV TRF Conts in Yr> from another pension arrangement(s) ' + FONT_NOISE + ' £1,589.23',
  'The table below shows the value of your Pension Savings Account in the Main Plan at 1 July 2022',
  'Total Fund value Your The Firm’s Total Unit price Fund Expense ' + NOISE_WITH_CONTROLS + ' contributions contributions units value Ratio at',
  'FUND NAME ' + FUND_NOISE + ' 0.65 0.37 £0.00 £1,589.23 £6,357.05 754.2317 £9.90 £7,466.14 Growth ' + '\u00bc\u00b9\u00c1\u00be\u00b2',
  'Total £0.00 £1,589.23 £6,357.05 £7,466.14',
  'Member name Emilia King Statement date 1 July 2022 Date of birth 15 December 1995',
  'Date joined Plan 05 July 2021 Normal Pension Date 15 December 2060 Base Salary £80,000.00 Benefit Salary £80,000.00',
  'The estimated total value of your Pension Savings Account at your Normal Pension Date is £274,000.00',
  'up to a maximum of 13% of your Benefit Salary',
);

const CONDENSED_2023 = pagesOf(
  'Pension Plan Statement 2023 Emilia , this is your 2023 Pension Plan statement.',
  'This is your personal statement of benefits provided for you as a member of the Morgan Stanley UK Group Pension Plan and Top-Up Pension Plan (the Plans). It is calculated as at 1 July 2023.',
  'MONEY YOU HAVE SAVED MONEY ADDED BY THE FIRM CHANGE IN VALUE TOTAL AMOUNT OF MONEY IN YOUR PENSION ACCOUNT',
  'Main Plan £4,290.44 + £13,993.26 + £111.90 = £18,395.60',
  'Top-Up Plan £0.00 + £0.00 + £0.00 = £0.00',
  'Total £4,290.44 + £13,993.26 + £111.90 = £18,395.60',
  'HERE IS A SUMMARY OF WHAT HAS CHANGED IN YOUR ACCOUNT BETWEEN 1 JULY 2022 AND 1 JULY 2023:',
  'Total amount of money in the Main and Top-Up Plan on 1 July 2022 £7,466.14',
  'You have saved into your account £2,701.21',
  'The Firm has added £7,636.21',
  'Additional savings you have made into the Top-Up Plan £0.00',
  'Bonus you have waived into the Top-Up Plan £0.00',
  'You have transferred in from other pension schemes £0.00',
  'Investment growth (minus charges) has contributed £592.04',
  'Total amount of money in the Main and Top-Up Plan on 1 July 2023 £18,395.60',
  'In the Plan year to 31 December 2022, you paid £1,599.96 to the Main Plan and £0.00 to the Top-Up Plan, while the Firm paid £6,399.96 and £0.00 respectively.',
  'AT 15 December 2060, YOUR TARGET RETIREMENT DATE, WE ESTIMATE YOU COULD GET:',
  'Your pension account could be worth £676,000.00 £0.00 £676,000.00',
);

test('gibberish from a subsetted font is dropped, real text is kept', () => {
  assert.equal(F.dropGibberish('Fund Expense ' + FONT_NOISE + ' contributions').replace(/\s+/g, ' ').trim(),
    'Fund Expense contributions');
  // control characters would otherwise split a run into pieces too short to recognise
  assert.equal(F.dropGibberish('at ' + NOISE_WITH_CONTROLS + ' value').replace(/\s+/g, ' ').trim(), 'at value');
  assert.equal(F.dropGibberish('Active Diversified Growth £1,589.23'), 'Active Diversified Growth £1,589.23');
});

test("2022 booklet: the year's contributions, not the next label's figure", () => {
  const S = F.parseStatement(BOOKLET_2022);
  assert.ok(S, 'the booklet must parse');
  assert.equal(S.date, '2022-07-01');
  assert.equal(S.year, 2022);
  assert.equal(S.totalValue, 7466.14);
  // these were the misread ones: employee and avc both took the Firm's 6,357.05,
  // and transferIn took the member's 1,589.23
  assert.equal(S.employer, 6357.05, 'the Firm paid 6,357.05');
  assert.equal(S.employee, 1589.23, 'the member paid 1,589.23');
  assert.equal(S.avc, null, 'no AVCs — that label is followed by an unfilled placeholder');
  assert.equal(S.transferIn, null, 'nothing was transferred in');
  assert.ok(Math.abs(F.stmtPaidIn(S) - 7946.28) < 0.01, 'paid in ' + F.stmtPaidIn(S));
  assert.ok(Math.abs(F.stmtGrowth(S) + 480.14) < 0.01, 'growth ' + F.stmtGrowth(S));
});

test('2022 booklet: personal details and the fund held', () => {
  const S = F.parseStatement(BOOKLET_2022);
  assert.equal(S.dob, '1995-12-15');
  assert.equal(S.npd, '2060-12-15');
  assert.equal(S.joined, '2021-07-05');
  assert.equal(S.benefitSalary, 80000);
  assert.equal(S.firmMaxPct, 13);
  assert.equal(S.estAtNPD, 274000);
  assert.equal(S.plans.Main.endValue, 7466.14);
  assert.equal(S.funds.length, 1);
  const f = S.funds[0];
  assert.equal(f.name, 'Active Diversified Growth', 'the two-line fund name is reassembled');
  assert.equal(f.endValue, 7466.14);
  assert.equal(f.unitPrice, 9.9);
  assert.equal(f.ter, null, 'the charge column is unmarked here, so no TER is claimed');
});

test('2023 condensed statement reads every figure on the page', () => {
  const S = F.parseStatement(CONDENSED_2023);
  assert.ok(S, 'the condensed template must parse');
  assert.equal(S.date, '2023-07-01');
  assert.equal(S.totalValue, 18395.6);
  assert.equal(S.prevDate, '2022-07-01');
  assert.equal(S.prevTotal, 7466.14);
  assert.equal(S.employee, 2701.21);
  assert.equal(S.employer, 7636.21);
  assert.equal(S.avc, 0);
  assert.equal(S.bonusWaived, 0);
  assert.equal(S.transferIn, 0);
  assert.equal(S.growthStated, 592.04);
  assert.equal(S.estAtNPD, 676000);
  assert.equal(S.npd, '2060-12-15');
  assert.equal(S.accumulated.Total.saved, 4290.44);
  assert.equal(S.accumulated.Total.firm, 13993.26);
  assert.equal(S.accumulated.Total.growth, 111.9);
  // the statutory "In the Plan year to 31 December 2022" figures cover a different
  // period and must not be mistaken for this year's contributions
  assert.notEqual(S.employee, 1599.96);
  assert.notEqual(S.employer, 6399.96);
});

test('the two years line up: 2023 opens where 2022 closed', () => {
  const a = F.parseStatement(BOOKLET_2022), b = F.parseStatement(CONDENSED_2023);
  assert.equal(a.totalValue, b.prevTotal, "2023's opening balance is 2022's closing balance");
  assert.equal(a.date, b.prevDate);
});
