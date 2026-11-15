const test = require('node:test');
const assert = require('node:assert/strict');
const {
  runMonteCarlo,
  estimateAssetMoments,
  estimateCorrelationMatrix,
} = require('/tmp/wealth-os-engine/monteCarloEngine.js');

const asset = (overrides = {}) => ({ name: 'Test asset', ticker: 'TEST', weight: 1, mean: 7, vol: 0, ...overrides });
const config = (overrides = {}) => ({
  years: 1,
  initialValue: 1000,
  annualCashflow: 0,
  frequency: 12,
  inflationAdjustedCashflows: false,
  inflationMean: 0,
  inflationVolatility: 0,
  model: 'parameterized',
  distribution: 'normal',
  degreesOfFreedom: 5,
  cashflowType: 'contribution',
  annualWithdrawalRate: 4,
  currentAge: 40,
  sequenceStressYears: 0,
  blockYears: 1,
  rebalancing: 'annual',
  seed: 12345,
  ...overrides,
});
const flatHistory = (value = 0, count = 24) => Array.from({ length: count }, (_, i) => ({
  date: `${2020 + Math.floor((i + 1) / 12)}-${String((i + 1) % 12 + 1).padStart(2, '0')}`,
  returns: [value],
}));

test('zero-volatility parameterized path compounds to the exact annual expected return', () => {
  const [result] = runMonteCarlo(config(), [asset()], [], 1);
  assert.ok(Math.abs(result.ending - 1070) < 1e-7);
  assert.ok(Math.abs(result.annualizedReturn - 0.07) < 1e-10);
});

test('annual contribution is invested at the selected year-end payment date', () => {
  const [result] = runMonteCarlo(config({ annualCashflow: 1200, frequency: 1 }), [asset({ mean: 0 })], [], 1);
  assert.ok(Math.abs(result.ending - 2200) < 1e-7);
  assert.equal(result.totalContributions, 1200);
});

test('monthly contributions sum to the configured annual amount', () => {
  const [result] = runMonteCarlo(config({ annualCashflow: 1200, frequency: 12 }), [asset({ mean: 0 })], [], 1);
  assert.ok(Math.abs(result.ending - 2200) < 1e-7);
  assert.equal(result.totalContributions, 1200);
});

test('withdrawal survival is true when every scheduled withdrawal is funded', () => {
  const [result] = runMonteCarlo(config({ initialValue: 1000, annualCashflow: 600, frequency: 12, cashflowType: 'withdrawal' }), [asset({ mean: 0 })], [], 1);
  assert.ok(Math.abs(result.ending - 400) < 1e-7);
  assert.equal(result.totalWithdrawals, 600);
  assert.equal(result.survived, true);
});

test('withdrawal survival is false when the portfolio cannot fund the full schedule', () => {
  const [result] = runMonteCarlo(config({ initialValue: 100, annualCashflow: 1200, frequency: 12, cashflowType: 'withdrawal' }), [asset({ mean: 0 })], [], 1);
  assert.equal(result.ending, 0);
  assert.equal(result.totalWithdrawals, 100);
  assert.equal(result.survived, false);
});

test('cashflow-adjusted maximum drawdown is not distorted by contributions', () => {
  const [result] = runMonteCarlo(config({ annualCashflow: 1200, frequency: 12 }), [asset({ mean: 0 })], [], 1);
  assert.ok(Math.abs(result.maxDrawdown) < 1e-12);
});

test('historical bootstrap rejects missing asset observations instead of inventing returns', () => {
  const history = flatHistory(0).map((row, i) => ({ ...row, returns: i === 3 ? [NaN] : row.returns }));
  assert.throws(() => runMonteCarlo(config({ model: 'historical' }), [asset()], history, 1), /complete, valid returns/);
});

test('historical bootstrap preserves a flat historical return series', () => {
  const [result] = runMonteCarlo(config({ model: 'historical' }), [asset()], flatHistory(0), 1);
  assert.ok(Math.abs(result.ending - 1000) < 1e-7);
  assert.equal(result.annualizedReturn, 0);
});

test('inflation-adjusted terminal value deflates nominal value by the compounded inflation factor', () => {
  const [result] = runMonteCarlo(config({ inflationMean: 2, inflationVolatility: 0 }), [asset({ mean: 0 })], [], 1);
  assert.ok(Math.abs(result.ending - 1000) < 1e-7);
  assert.ok(Math.abs(result.realEnding - 1000 / 1.02) < 1e-7);
});

test('same seed reproduces identical paths', () => {
  const first = runMonteCarlo(config({ years: 3, seed: 9876 }), [asset({ vol: 15 })], [], 10);
  const second = runMonteCarlo(config({ years: 3, seed: 9876 }), [asset({ vol: 15 })], [], 10);
  assert.deepEqual(first, second);
});

test('Student-t simulation supports non-integer degrees of freedom and finite outputs', () => {
  const results = runMonteCarlo(config({ distribution: 'student', degreesOfFreedom: 5.5, years: 3 }), [asset({ vol: 20 })], [], 100);
  assert.ok(results.every(row => Number.isFinite(row.ending) && row.ending >= 0));
});

test('statistical model estimates arithmetic annualized moments from complete monthly observations', () => {
  const history = flatHistory(0.01);
  const [moments] = estimateAssetMoments(history, 1);
  assert.ok(Math.abs(moments.mean - 0.12) < 1e-10);
  assert.ok(Math.abs(moments.vol) < 1e-10);
  const [result] = runMonteCarlo(config({ model: 'statistical' }), [asset({ mean: -20, vol: 40 })], history, 1);
  assert.ok(Math.abs(result.ending - 1120) < 1e-6);
});

test('correlation estimation returns a symmetric matrix with unit diagonal', () => {
  const history = Array.from({ length: 20 }, (_, i) => ({ date: `2020-${String(i + 1).padStart(2, '0')}`, returns: [i / 100, i / 200] }));
  const matrix = estimateCorrelationMatrix(history, 2);
  assert.equal(matrix[0][0], 1);
  assert.equal(matrix[1][1], 1);
  assert.ok(Math.abs(matrix[0][1] - matrix[1][0]) < 1e-12);
  assert.ok(matrix[0][1] > 0.99);
});
