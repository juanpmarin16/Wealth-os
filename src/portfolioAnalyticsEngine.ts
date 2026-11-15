export type DatedPrice = { date: string; value: number };
export type AssetPriceSeries = { id: string; prices: DatedPrice[] };
export type AlignedReturnRow = { date: string; returns: number[] };
export type Rebalancing = 'monthly' | 'annual' | 'none';
export type PortfolioStats = {
  daily: number[]; nav: number[]; annualReturn: number | null; vol: number | null;
  sharpe: number | null; sortino: number | null; maxDD: number | null;
  periodsPerYear: number; elapsedYears: number;
};
export type TailRisk = { varLoss: number | null; cvarLoss: number | null; observations: number };

const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const sampleStdDev = (values: number[]) => values.length > 1
  ? Math.sqrt(values.reduce((sum, value) => sum + (value - average(values)) ** 2, 0) / (values.length - 1)) : 0;
const dayNumber = (date: string) => Date.parse(date + 'T00:00:00Z') / 86400000;

export function quantile(values: number[], probability: number): number | null {
  if (!values.length) return null;
  const p = Math.min(1, Math.max(0, probability));
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  return sorted[lower] + (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]) * (index - lower);
}

export function alignDailyAssetReturns(series: AssetPriceSeries[], maxStaleDays = 5): AlignedReturnRow[] {
  if (!series.length || series.some(item => !item.prices.length)) return [];
  const maps = series.map(item => new Map(item.prices
    .filter(point => Number.isFinite(point.value) && point.value > 0 && /^\\d{4}-\\d{2}-\\d{2}$/.test(point.date))
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(point => [point.date, point.value])));
  const dates = [...new Set(maps.flatMap(map => [...map.keys()]))].sort();
  const latestPrices = Array(series.length).fill(0) as number[];
  const latestDates = Array(series.length).fill('') as string[];
  let previousPrices: number[] | null = null;
  let previousDate = '';
  const output: AlignedReturnRow[] = [];
  for (const date of dates) {
    maps.forEach((map, index) => {
      const price = map.get(date);
      if (price !== undefined) { latestPrices[index] = price; latestDates[index] = date; }
    });
    if (latestPrices.some(price => price <= 0)) continue;
    const stale = latestDates.some(lastDate => dayNumber(date) - dayNumber(lastDate) > maxStaleDays);
    if (stale) {
      previousPrices = [...latestPrices];
      previousDate = date;
      continue;
    }
    if (previousPrices && previousDate) {
      const elapsedDays = dayNumber(date) - dayNumber(previousDate);
      const returns = latestPrices.map((price, index) => price / previousPrices![index] - 1);
      if (elapsedDays > 0 && elapsedDays <= maxStaleDays && returns.every(value => Number.isFinite(value) && value > -1)) {
        output.push({ date, returns });
      }
    }
    previousPrices = [...latestPrices];
    previousDate = date;
  }
  return output;
}

export function calculatePortfolioStats(
  rows: AlignedReturnRow[],
  weights: number[],
  riskFreeRate = 0.02,
  rebalancing: Rebalancing = 'annual',
): PortfolioStats {
  const empty = { daily: [], nav: [100], annualReturn: null, vol: null, sharpe: null, sortino: null, maxDD: null, periodsPerYear: 0, elapsedYears: 0 };
  if (!rows.length || weights.length !== rows[0].returns.length || rows.some(row => row.returns.length !== weights.length || row.returns.some(value => !Number.isFinite(value)))) return empty;
  const totalWeight = weights.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (totalWeight <= 0) return empty;
  const targetWeights = weights.map(value => Math.max(0, value) / totalWeight);
  let currentWeights = [...targetWeights];
  let previousMonth = rows[0].date.slice(0, 7);
  let previousYear = rows[0].date.slice(0, 4);
  let nav = 100, peak = 100, maxDD = 0;
  const navSeries = [nav];
  const portfolioReturns: number[] = [];
  rows.forEach(row => {
    const month = row.date.slice(0, 7), year = row.date.slice(0, 4);
    if ((rebalancing === 'monthly' && month !== previousMonth) || (rebalancing === 'annual' && year !== previousYear)) currentWeights = [...targetWeights];
    const portfolioReturn = row.returns.reduce((sum, assetReturn, index) => sum + currentWeights[index] * assetReturn, 0);
    portfolioReturns.push(portfolioReturn);
    nav *= 1 + portfolioReturn;
    navSeries.push(nav);
    peak = Math.max(peak, nav);
    maxDD = Math.max(maxDD, peak > 0 ? 1 - nav / peak : 0);
    const gross = 1 + portfolioReturn;
    if (gross > 0) currentWeights = currentWeights.map((weight, index) => weight * (1 + row.returns[index]) / gross);
    previousMonth = month;
    previousYear = year;
  });
  const elapsedDays = dayNumber(rows[rows.length - 1].date) - dayNumber(rows[0].date);
  const elapsedYears = elapsedDays > 0 ? elapsedDays / 365.25 : 0;
  const periodsPerYear = elapsedYears > 0 ? portfolioReturns.length / elapsedYears : 0;
  if (!periodsPerYear || !elapsedYears) return { ...empty, daily: portfolioReturns, nav: navSeries, maxDD };
  const dailyVol = sampleStdDev(portfolioReturns);
  const dailyRiskFree = Math.pow(1 + riskFreeRate, 1 / periodsPerYear) - 1;
  const meanExcess = average(portfolioReturns) - dailyRiskFree;
  const annualVol = dailyVol * Math.sqrt(periodsPerYear);
  const downsideDeviation = Math.sqrt(average(portfolioReturns.map(value => Math.min(0, value - dailyRiskFree) ** 2))) * Math.sqrt(periodsPerYear);
  return {
    daily: portfolioReturns,
    nav: navSeries,
    annualReturn: nav > 0 ? Math.pow(nav / 100, 1 / elapsedYears) - 1 : -1,
    vol: annualVol,
    sharpe: dailyVol > 0 ? meanExcess / dailyVol * Math.sqrt(periodsPerYear) : null,
    sortino: downsideDeviation > 0 ? meanExcess * periodsPerYear / downsideDeviation : null,
    maxDD,
    periodsPerYear,
    elapsedYears,
  };
}

export function rollingReturnsByCalendarDays(rows: AlignedReturnRow[], windowDays: number): number[] {
  if (windowDays < 1 || rows.length < 2) return [];
  const output: number[] = [];
  let start = 0;
  for (let end = 1; end < rows.length; end++) {
    const targetDay = dayNumber(rows[end].date) - windowDays;
    while (start + 1 < end && dayNumber(rows[start + 1].date) <= targetDay) start++;
    if (dayNumber(rows[end].date) - dayNumber(rows[start].date) < windowDays) continue;
    let gross = 1;
    for (let i = start + 1; i <= end; i++) gross *= 1 + rows[i].returns.reduce((sum, value, index) => sum + value * 0, 0);
    // Portfolio-level rolling returns are supplied by rollingPortfolioReturns below.
    output.push(gross - 1);
  }
  return output;
}

export function rollingPortfolioReturns(dates: string[], portfolioReturns: number[], windowDays: number): number[] {
  if (dates.length !== portfolioReturns.length || windowDays < 1) return [];
  const output: number[] = [];
  let start = 0;
  for (let end = 1; end < dates.length; end++) {
    const targetDay = dayNumber(dates[end]) - windowDays;
    while (start + 1 < end && dayNumber(dates[start + 1]) <= targetDay) start++;
    if (dayNumber(dates[end]) - dayNumber(dates[start]) < windowDays) continue;
    let gross = 1;
    for (let i = start + 1; i <= end; i++) gross *= 1 + portfolioReturns[i];
    output.push(gross - 1);
  }
  return output;
}

export function calculateHistoricalTailRisk(returns: number[], confidence: number): TailRisk {
  const threshold = quantile(returns, 1 - confidence);
  if (threshold === null) return { varLoss: null, cvarLoss: null, observations: 0 };
  const tail = returns.filter(value => value <= threshold);
  return {
    varLoss: Math.max(0, -threshold),
    cvarLoss: tail.length ? Math.max(0, -average(tail)) : null,
    observations: returns.length,
  };
}

export function correlationMatrix(rows: AlignedReturnRow[]): number[][] {
  if (!rows.length) return [];
  const columns = rows[0].returns.map((_, index) => rows.map(row => row.returns[index]));
  return columns.map((left, i) => columns.map((right, j) => {
    if (i === j) return 1;
    const leftMean = average(left), rightMean = average(right);
    const leftVariance = left.reduce((sum, value) => sum + (value - leftMean) ** 2, 0);
    const rightVariance = right.reduce((sum, value) => sum + (value - rightMean) ** 2, 0);
    if (leftVariance <= 0 || rightVariance <= 0) return 0;
    const covarianceSum = left.reduce((sum, value, index) => sum + (value - leftMean) * (right[index] - rightMean), 0);
    return covarianceSum / Math.sqrt(leftVariance * rightVariance);
  }));
}
