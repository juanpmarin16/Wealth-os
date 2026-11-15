const test = require('node:test');
const assert = require('node:assert/strict');
const {
  alignDailyAssetReturns,
  calculatePortfolioStats,
  rollingPortfolioReturns,
  calculateHistoricalTailRisk,
  correlationMatrix,
} = require('/tmp/wealth-os-engine/portfolioAnalyticsEngine.js');

const dailyDates = (start, count) => Array.from({ length: count }, (_, i) => new Date(Date.parse(start + 'T00:00:00Z') + i * 86400000).toISOString().slice(0, 10));
const rowsFor = (returns) => returns.map((value, i) => ({ date: dailyDates('2023-01-01', returns.length + 1)[i + 1], returns: [value] }));

test('daily alignment uses a union calendar and carries forward the last valid market close', () => {
  const rows = alignDailyAssetReturns([
    { id: 'a', prices: [{ date: '2024-01-01', value: 100 }, { date: '2024-01-02', value: 110 }, { date: '2024-01-04', value: 121 }] },
    { id: 'b', prices: [{ date: '2024-01-01', value: 100 }, { date: '2024-01-03', value: 100 }, { date: '2024-01-04', value: 110 }] },
  ]);
  assert.equal(rows.length, 3);
  assert.ok(Math.abs(rows[0].returns[0] - 0.1) < 1e-12);
  assert.equal(rows[0].returns[1], 0);
  assert.equal(rows[1].returns[0], 0);
  assert.ok(Math.abs(rows[2].returns[1] - 0.1) < 1e-12);
});

test('stale prices beyond the permitted gap are not converted into multi-day daily returns', () => {
  const rows = alignDailyAssetReturns([
    { id: 'a', prices: [{ date: '2024-01-01', value: 100 }, { date: '2024-01-10', value: 120 }] },
    { id: 'b', prices: [{ date: '2024-01-01', value: 100 }, { date: '2024-01-10', value: 100 }] },
  ], 5);
  assert.equal(rows.length, 0);
});

test('buy-and-hold portfolio NAV reflects asset weight drift rather than daily rebalancing', () => {
  const rows = [
    { date: '2024-01-02', returns: [0.1, 0] },
    { date: '2024-01-03', returns: [0.1, 0] },
  ];
  const stats = calculatePortfolioStats(rows, [0.5, 0.5], 0, 'none');
  const expected = 100 * (1 + 0.5 * 0.1) * (1 + (0.55 / 1.05) * 0.1);
  assert.ok(Math.abs(stats.nav[2] - expected) < 1e-10);
});

test('maximum drawdown is measured from portfolio NAV', () => {
  const stats = calculatePortfolioStats(rowsFor([0.1, -0.2]), [1], 0, 'none');
  assert.ok(Math.abs(stats.maxDD - 0.2) < 1e-12);
});

test('annualized return uses the actual observation date span', () => {
  const dates = dailyDates('2023-01-01', 366).slice(1);
  const rows = dates.map((date, index) => ({ date, startDate: index === 0 ? '2023-01-01' : dates[index - 1], returns: [0.001] }));
  const stats = calculatePortfolioStats(rows, [1], 0, 'none');
  assert.ok(Math.abs(stats.annualReturn - (Math.pow(1.001, 365.25) - 1)) < 1e-9);
});

test('monthly and annual historical risk windows compound returns over calendar days', () => {
  const dates = dailyDates('2024-01-01', 41);
  const returns = Array(40).fill(0.01);
  const rolling = rollingPortfolioReturns(dates.slice(1), returns, 30);
  assert.ok(rolling.length > 0);
  assert.ok(rolling.every(value => Math.abs(value - (Math.pow(1.01, 30) - 1)) < 1e-10));
});

test('historical VaR and CVaR are calculated directly from the selected horizon sample', () => {
  const result = calculateHistoricalTailRisk([-0.1, -0.05, 0, 0.02, 0.04], 0.8);
  assert.equal(result.observations, 5);
  assert.ok(result.varLoss >= 0.05);
  assert.ok(result.cvarLoss >= result.varLoss);
});

test('correlation matrix is symmetric with unit diagonal', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ date: dailyDates('2024-01-01', 10)[i], returns: [i / 100, i / 200] }));
  const matrix = correlationMatrix(rows);
  assert.equal(matrix[0][0], 1);
  assert.equal(matrix[1][1], 1);
  assert.ok(Math.abs(matrix[0][1] - matrix[1][0]) < 1e-12);
  assert.ok(matrix[0][1] > 0.99);
});

test('alignment resets its return baseline after a stale-data gap', () => {
  const rows = alignDailyAssetReturns([
    { id: 'a', prices: [{ date: '2024-01-01', value: 100 }, { date: '2024-01-10', value: 120 }, { date: '2024-01-11', value: 121 }] },
    { id: 'b', prices: [{ date: '2024-01-01', value: 100 }, { date: '2024-01-10', value: 100 }, { date: '2024-01-11', value: 110 }] },
  ], 5);
  assert.equal(rows.length, 1);
  assert.ok(Math.abs(rows[0].returns[0] - (121 / 120 - 1)) < 1e-12);
  assert.ok(Math.abs(rows[0].returns[1] - 0.1) < 1e-12);
});
