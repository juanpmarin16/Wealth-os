export type SimulationAsset = { name?: string; ticker?: string; weight: number; mean: number; vol: number };
export type HistoryRow = { date: string; returns: number[] };
export type SimulationModel = 'historical' | 'statistical' | 'parameterized';
export type ReturnDistribution = 'normal' | 'student';
export type CashflowType = 'contribution' | 'withdrawal' | 'percentage' | 'life';
export type PathSummary = {
  ending: number; realEnding: number; survived: boolean; maxDrawdown: number;
  yearly: number[]; annualizedReturn: number; totalContributions: number; totalWithdrawals: number;
};
export type SimulationConfig = {
  years: number; initialValue: number; annualCashflow: number; frequency: number;
  inflationAdjustedCashflows: boolean; inflationMean: number; inflationVolatility: number;
  model: SimulationModel; distribution: ReturnDistribution; degreesOfFreedom: number;
  cashflowType: CashflowType; annualWithdrawalRate: number; currentAge: number;
  sequenceStressYears: number; blockYears: number; rebalancing: 'monthly' | 'annual' | 'none';
  seed?: number;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const monthIndex = (date: string) => {
  const match = /^(\\d{4})-(\\d{2})$/.exec(date);
  return match ? Number(match[1]) * 12 + Number(match[2]) - 1 : NaN;
};

export function createRandom(seed = 1): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function normalRandom(random: () => number): number {
  const u = Math.max(random(), 1e-12);
  const v = Math.max(random(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function gammaRandom(shape: number, random: () => number): number {
  if (shape <= 0) throw new Error('Gamma shape must be positive.');
  if (shape < 1) return gammaRandom(shape + 1, random) * Math.pow(Math.max(random(), 1e-12), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let attempt = 0; attempt < 10000; attempt++) {
    const x = normalRandom(random);
    const v0 = 1 + c * x;
    if (v0 <= 0) continue;
    const v = v0 * v0 * v0;
    const u = Math.max(random(), 1e-12);
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
  throw new Error('Student-t random generator did not converge.');
}

function standardizedStudentT(df: number, random: () => number): number {
  const chiSquare = 2 * gammaRandom(df / 2, random);
  return normalRandom(random) / Math.sqrt(Math.max(chiSquare / df, 1e-12)) * Math.sqrt((df - 2) / df);
}

function choleskyCorrelation(correlation: number[][]): number[][] {
  const n = correlation.length;
  const ridge = 1e-8;
  const matrix = correlation.map((row, i) => row.map((value, j) => (1 - ridge) * value + (i === j ? ridge : 0)));
  const lower = Array.from({ length: n }, () => Array(n).fill(0) as number[]);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = matrix[i][j];
      for (let k = 0; k < j; k++) sum -= lower[i][k] * lower[j][k];
      if (i === j) {
        if (sum < -1e-7) throw new Error('The estimated correlation matrix is not positive semidefinite. Use more complete historical observations or fewer assets.');
        lower[i][j] = Math.sqrt(Math.max(sum, 1e-12));
      } else {
        lower[i][j] = lower[j][j] > 1e-10 ? sum / lower[j][j] : 0;
      }
    }
  }
  return lower;
}

export function estimateAssetMoments(history: HistoryRow[], assetCount: number): Array<{ mean: number; vol: number }> {
  const complete = history.filter(row => row.returns.length === assetCount && row.returns.every(Number.isFinite));
  if (complete.length < 12) throw new Error('Statistical returns require at least 12 complete monthly observations for every selected asset.');
  return Array.from({ length: assetCount }, (_, index) => {
    const values = complete.map(row => row.returns[index]);
    const meanMonthly = values.reduce((sum, value) => sum + value, 0) / values.length;
    const varianceMonthly = values.reduce((sum, value) => sum + (value - meanMonthly) ** 2, 0) / (values.length - 1);
    return { mean: meanMonthly * 12, vol: Math.sqrt(varianceMonthly * 12) };
  });
}

export function estimateCorrelationMatrix(history: HistoryRow[], assetCount: number): number[][] {
  const complete = history.filter(row => row.returns.length === assetCount && row.returns.every(Number.isFinite));
  if (complete.length < 3) throw new Error('At least three complete observations are required to estimate correlations.');
  const means = Array.from({ length: assetCount }, (_, i) => complete.reduce((sum, row) => sum + row.returns[i], 0) / complete.length);
  const sums = Array.from({ length: assetCount }, (_, i) => complete.reduce((sum, row) => sum + (row.returns[i] - means[i]) ** 2, 0));
  return Array.from({ length: assetCount }, (_, i) => Array.from({ length: assetCount }, (_, j) => {
    if (i === j) return 1;
    if (sums[i] <= 1e-18 || sums[j] <= 1e-18) return 0;
    const covarianceSum = complete.reduce((sum, row) => sum + (row.returns[i] - means[i]) * (row.returns[j] - means[j]), 0);
    return clamp(covarianceSum / Math.sqrt(sums[i] * sums[j]), -1, 1);
  }));
}

function validateInputs(config: SimulationConfig, assets: SimulationAsset[], history: HistoryRow[]): void {
  if (!Number.isInteger(config.years) || config.years < 1 || config.years > 60) throw new Error('The investment horizon must be between 1 and 60 whole years.');
  if (!Number.isFinite(config.initialValue) || config.initialValue < 0) throw new Error('Initial value must be finite and non-negative.');
  if (!Number.isFinite(config.annualCashflow) || config.annualCashflow < 0) throw new Error('Annual cashflow must be finite and non-negative.');
  if (![1, 2, 4, 12].includes(config.frequency)) throw new Error('Cashflow frequency must be annual, semi-annual, quarterly or monthly.');
  if (!assets.length || assets.some(asset => !Number.isFinite(asset.weight) || asset.weight < 0 || !Number.isFinite(asset.mean) || asset.mean <= -100 || !Number.isFinite(asset.vol) || asset.vol < 0)) throw new Error('Every asset must have a non-negative weight, expected return above -100%, and non-negative volatility.');
  if (assets.reduce((sum, asset) => sum + asset.weight, 0) <= 0) throw new Error('Portfolio weights must add up to more than zero.');
  if (config.model === 'historical') {
    if (history.length < 12) throw new Error('Historical bootstrap requires at least 12 complete monthly observations.');
    if (history.some(row => row.returns.length !== assets.length || row.returns.some(value => !Number.isFinite(value) || value <= -1))) throw new Error('Historical bootstrap requires complete, valid returns for every selected asset. Missing observations cannot be replaced with synthetic returns.');
    if (!Number.isInteger(config.blockYears) || config.blockYears < 1 || config.blockYears * 12 > history.length) throw new Error('The selected bootstrap block is longer than the available historical sample.');
  }
  if (config.model === 'statistical' && history.filter(row => row.returns.length === assets.length && row.returns.every(Number.isFinite)).length < 12) throw new Error('Statistical returns require at least 12 complete monthly observations.');
  if (config.distribution === 'student' && (!Number.isFinite(config.degreesOfFreedom) || config.degreesOfFreedom <= 2)) throw new Error('Student-t degrees of freedom must be greater than 2.');
  if (!Number.isFinite(config.inflationMean) || config.inflationMean <= -100 || !Number.isFinite(config.inflationVolatility) || config.inflationVolatility < 0) throw new Error('Inflation assumptions are invalid.');
}

function annualLogParameters(meanPercent: number, volatilityPercent: number): { meanLog: number; volatilityLog: number } {
  const mean = meanPercent / 100;
  const volatility = volatilityPercent / 100;
  if (mean <= -1) throw new Error('Expected annual return must be greater than -100%.');
  const ratio = volatility / (1 + mean);
  const varianceLog = Math.log1p(ratio * ratio);
  return { meanLog: Math.log1p(mean) - varianceLog / 2, volatilityLog: Math.sqrt(varianceLog) };
}

function buildMonthlyReturns(
  config: SimulationConfig,
  assets: SimulationAsset[],
  history: HistoryRow[],
  correlation: number[][],
  random: () => number,
): number[][] {
  const months = config.years * 12;
  if (config.model === 'historical') {
    const blockLength = config.blockYears * 12;
    const validStarts = Array.from({ length: history.length - blockLength + 1 }, (_, start) => start)
      .filter(start => Array.from({ length: blockLength - 1 }, (_, i) => monthIndex(history[start + i + 1].date) - monthIndex(history[start + i].date)).every(delta => delta === 1));
    if (!validStarts.length) throw new Error('No uninterrupted historical block is long enough for the selected bootstrap length.');
    const sampled: number[][] = [];
    while (sampled.length < months) {
      const start = validStarts[Math.floor(random() * validStarts.length)];
      for (let i = 0; i < blockLength && sampled.length < months; i++) sampled.push([...history[start + i].returns]);
    }
    return sampled;
  }

  const lower = choleskyCorrelation(correlation);
  const statisticalMoments = config.model === 'statistical' ? estimateAssetMoments(history, assets.length) : null;
  const modelAssets = assets.map((asset, i) => statisticalMoments ? { ...asset, mean: statisticalMoments[i].mean, vol: statisticalMoments[i].vol } : asset);
  const generated: number[][] = [];
  for (let month = 0; month < months; month++) {
    const independent = modelAssets.map(() => normalRandom(random));
    const correlatedNormal = independent.map((_, i) => lower[i].slice(0, i + 1).reduce((sum, coefficient, j) => sum + coefficient * independent[j], 0));
    const commonTScale = config.distribution === 'student'
      ? Math.sqrt((config.degreesOfFreedom - 2) / (2 * gammaRandom(config.degreesOfFreedom / 2, random)))
      : 1;
    generated.push(modelAssets.map((asset, i) => {
      if (config.distribution === 'student') {
        const monthlyMean = asset.mean / 100 / 12;
        const monthlyVol = asset.vol / 100 / Math.sqrt(12);
        return Math.max(-0.999999, monthlyMean + monthlyVol * correlatedNormal[i] * commonTScale);
      }
      const parameters = annualLogParameters(asset.mean, asset.vol);
      return Math.exp(parameters.meanLog / 12 + parameters.volatilityLog / Math.sqrt(12) * correlatedNormal[i]) - 1;
    }));
  }
  return generated;
}

function applySequenceStress(monthlyReturns: number[][], years: number, weights: number[], stressYears: number): number[][] {
  if (stressYears <= 0) return monthlyReturns;
  const annualBlocks = Array.from({ length: years }, (_, year) => ({
    year,
    return: monthlyReturns.slice(year * 12, (year + 1) * 12).reduce((growth, row) => growth * (1 + row.reduce((sum, value, i) => sum + weights[i] * value, 0)), 1) - 1,
  }));
  const worstYears = annualBlocks.slice().sort((a, b) => a.return - b.return).slice(0, Math.min(stressYears, years)).map(block => block.year);
  const order = [...worstYears, ...annualBlocks.map(block => block.year).filter(year => !worstYears.includes(year))];
  return order.flatMap(year => monthlyReturns.slice(year * 12, (year + 1) * 12));
}

function simulateOnePath(config: SimulationConfig, assets: SimulationAsset[], history: HistoryRow[], correlation: number[][], random: () => number): PathSummary {
  const totalWeight = assets.reduce((sum, asset) => sum + asset.weight, 0);
  const targetWeights = assets.map(asset => asset.weight / totalWeight);
  const sampled = buildMonthlyReturns(config, assets, history, correlation, random);
  const monthlyReturns = applySequenceStress(sampled, config.years, targetWeights, config.sequenceStressYears);
  let currentWeights = [...targetWeights];
  let nav = 1;
  let units = config.initialValue;
  let peakNav = 1;
  let maxDrawdown = 0;
  let cumulativeInflation = 1;
  let survived = true;
  let totalContributions = 0;
  let totalWithdrawals = 0;
  const yearly = [config.initialValue];
  const inflationParameters = annualLogParameters(config.inflationMean, config.inflationVolatility);
  const monthsPerCashflow = 12 / config.frequency;

  for (let month = 0; month < config.years * 12; month++) {
    const row = monthlyReturns[month];
    const portfolioReturn = row.reduce((sum, assetReturn, i) => sum + currentWeights[i] * assetReturn, 0);
    nav *= Math.max(0.000001, 1 + portfolioReturn);
    if (1 + portfolioReturn > 0) {
      currentWeights = currentWeights.map((weight, i) => weight * (1 + row[i]) / (1 + portfolioReturn));
    }
    if (config.rebalancing === 'monthly' || (config.rebalancing === 'annual' && (month + 1) % 12 === 0)) currentWeights = [...targetWeights];

    const inflationShock = config.inflationVolatility > 0 ? normalRandom(random) : 0;
    cumulativeInflation *= Math.exp(inflationParameters.meanLog / 12 + inflationParameters.volatilityLog / Math.sqrt(12) * inflationShock);
    let balance = units * nav;

    if ((month + 1) % monthsPerCashflow === 0) {
      let flow = config.annualCashflow / config.frequency * (config.inflationAdjustedCashflows ? cumulativeInflation : 1);
      if (config.cashflowType === 'withdrawal') flow = -flow;
      if (config.cashflowType === 'percentage') flow = -Math.max(0, balance * config.annualWithdrawalRate / 100 / config.frequency);
      if (config.cashflowType === 'life') {
        const ageAtPayment = config.currentAge + (month + 1) / 12;
        const remainingYears = Math.max(1, 100 - ageAtPayment);
        flow = -balance / remainingYears / config.frequency;
      }
      if (flow < 0) {
        const paid = Math.min(balance, -flow);
        units = nav > 0 ? Math.max(0, units - paid / nav) : 0;
        totalWithdrawals += paid;
        if (paid + 1e-8 < -flow) survived = false;
      } else {
        units += nav > 0 ? flow / nav : 0;
        totalContributions += flow;
      }
      balance = units * nav;
    } else {
      balance = units * nav;
    }

    peakNav = Math.max(peakNav, nav);
    maxDrawdown = Math.max(maxDrawdown, peakNav > 0 ? (peakNav - nav) / peakNav : 0);
    if ((month + 1) % 12 === 0) yearly.push(balance);
  }

  return {
    ending: units * nav,
    realEnding: units * nav / Math.max(cumulativeInflation, 1e-12),
    survived,
    maxDrawdown,
    yearly,
    annualizedReturn: Math.pow(Math.max(nav, 1e-12), 1 / config.years) - 1,
    totalContributions,
    totalWithdrawals,
  };
}

export function runMonteCarlo(config: SimulationConfig, assets: SimulationAsset[], history: HistoryRow[], paths: number): PathSummary[] {
  validateInputs(config, assets, history);
  if (!Number.isInteger(paths) || paths < 1 || paths > 50000) throw new Error('Simulation count must be between 1 and 50,000.');
  const completeHistory = history.filter(row => row.returns.length === assets.length && row.returns.every(Number.isFinite));
  const correlation = config.model === 'historical' ? [] : estimateCorrelationMatrix(completeHistory, assets.length);
  const random = createRandom(config.seed ?? 1);
  return Array.from({ length: paths }, () => simulateOnePath(config, assets, completeHistory, correlation, random));
}
