import { useEffect, useMemo, useState } from 'react';
import { db } from './data/database';

type PortfolioAsset = { name: string; ticker: string; category: string; value: number };
type Props = { initialPortfolioValue: number; portfolioAssets: PortfolioAsset[] };
type PathSummary = { ending: number; realEnding: number; survived: boolean; maxDrawdown: number; yearly: number[]; annualReturns: number[]; totalContributions: number; totalWithdrawals: number };
type HistoryRow = { date: string; returns: number[] };
type Model = 'historical' | 'statistical' | 'parameterized';
type Distribution = 'normal' | 'student';

const euro = (n: number) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(Number.isFinite(n) ? n : 0);
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
function randomNormal() {
  const u = Math.max(Math.random(), 1e-12);
  const v = Math.max(Math.random(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function quantile(values: number[], p: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lo = Math.floor(index);
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (index - lo);
}
function cholesky(matrix: number[][]) {
  const n = matrix.length, L = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let sum = matrix[i][j];
    for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
    L[i][j] = i === j ? Math.sqrt(Math.max(sum, 1e-8)) : sum / (L[j][j] || 1);
  }
  return L;
}
function studentRandom(df: number) {
  let chi = 0;
  for (let i = 0; i < df; i++) chi += randomNormal() ** 2;
  return randomNormal() / Math.sqrt(Math.max(chi / df, 1e-9)) * Math.sqrt((df - 2) / df);
}
function pathFor(years: number, start: number, cashflow: number, frequency: number, inflationAdjusted: boolean, inflation: number, assets: { weight: number; mean: number; vol: number }[], model: Model, distribution: Distribution, df: number, history: HistoryRow[], corr: number[][], flowType: 'contribution' | 'withdrawal' | 'percentage', withdrawalPct: number, sequenceStress: number): PathSummary {
  const steps = years * 12;
  const weights = assets.map(a => a.weight / (assets.reduce((s, b) => s + b.weight, 0) || 1));
  const historicalRows = history.length ? history : [];
  const L = cholesky(corr.length === assets.length ? corr : assets.map((_, i) => assets.map((__, j) => i === j ? 1 : 0)));
  const monthlyAssetReturns: number[][] = [];
  for (let month = 0; month < steps; month++) {
    if (model === 'historical' && historicalRows.length) {
      const row = historicalRows[Math.floor(Math.random() * historicalRows.length)];
      monthlyAssetReturns.push(assets.map((a, i) => Number.isFinite(row.returns[i]) ? row.returns[i] : Math.max(-.95, (Math.pow(1 + a.mean / 100, 1 / 12) - 1) + a.vol / 100 / Math.sqrt(12) * randomNormal())));
    } else {
      const z = assets.map(() => distribution === 'student' ? studentRandom(df) : randomNormal());
      const correlated = z.map((_, i) => L[i].slice(0, i + 1).reduce((sum, value, j) => sum + value * z[j], 0));
      monthlyAssetReturns.push(assets.map((a, i) => Math.max(-.95, Math.pow(1 + a.mean / 100, 1 / 12) - 1 + a.vol / 100 / Math.sqrt(12) * correlated[i])));
    }
  }
  if (sequenceStress > 0) {
    const blocks = Array.from({ length: years }, (_, y) => ({ y, r: monthlyAssetReturns.slice(y * 12, (y + 1) * 12).reduce((p, row) => p * (1 + row.reduce((v, r, i) => v + weights[i] * r, 0)), 1) - 1 }));
    const worst = blocks.slice().sort((a, b) => a.r - b.r).slice(0, sequenceStress).map(b => b.y);
    const order = [...worst, ...blocks.map(b => b.y).filter(y => !worst.includes(y))];
    const original = monthlyAssetReturns.slice();
    order.forEach((source, target) => { for (let m = 0; m < 12; m++) monthlyAssetReturns[target * 12 + m] = original[source * 12 + m]; });
  }
  let balance = start, peak = Math.max(start, 1), maxDrawdown = 0, cumulativeInflation = 1, survived = true, totalContributions = 0, totalWithdrawals = 0;
  const yearly: number[] = [start];
  const cashflowEvery = 12 / frequency;
  for (let month = 0; month < steps; month++) {
    cumulativeInflation *= Math.max(.5, 1 + (inflation / 100) / 12 + (inflation / 100) * .35 / Math.sqrt(12) * randomNormal());
    const r = monthlyAssetReturns[month].reduce((v, ret, i) => v + weights[i] * ret, 0);
    balance = Math.max(0, balance * (1 + r));
    if ((month + 1) % cashflowEvery === 0) {
      let flow = cashflow * (inflationAdjusted ? cumulativeInflation : 1) / frequency;
      if (flowType === 'withdrawal') flow = -flow;
      if (flowType === 'percentage') flow = -Math.max(0, balance * withdrawalPct / 100 / frequency);
      if (flow < 0) { const paid = Math.min(balance, -flow); balance -= paid; totalWithdrawals += paid; if (paid + 1e-8 < -flow) survived = false; }
      else { balance += flow; totalContributions += flow; }
    }
    peak = Math.max(peak, balance);
    maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - balance) / peak : 0);
    if ((month + 1) % 12 === 0) yearly.push(balance);
  }
  return { ending: balance, realEnding: balance / Math.max(cumulativeInflation, .01), survived, maxDrawdown, yearly, annualReturns: [], totalContributions, totalWithdrawals };
}

export default function MonteCarloSimulator({ initialPortfolioValue, portfolioAssets }: Props) {
  const suggestedStart = Math.max(0, Math.round(initialPortfolioValue || 0));
  const [initialAmount, setInitialAmount] = useState(String(suggestedStart));
  const [cashflow, setCashflow] = useState('12000');
  const [flowType, setFlowType] = useState<'contribution' | 'withdrawal' | 'percentage'>('contribution');
  const [frequency, setFrequency] = useState('12');
  const [years, setYears] = useState('30');
  const [runs, setRuns] = useState('5000');
  const [inflationAdjusted, setInflationAdjusted] = useState(true);
  const [inflation, setInflation] = useState('2.5');
  const [assets, setAssets] = useState([
    { name: 'Global Equities', weight: 60, mean: 7, vol: 16 },
    { name: 'Bonds', weight: 40, mean: 3.5, vol: 7 },
  ]);
  const [results, setResults] = useState<PathSummary[] | null>(null);
  const [model, setModel] = useState<Model>('historical');
  const [distribution, setDistribution] = useState<Distribution>('student');
  const [df, setDf] = useState('5');
  const [sequenceStress, setSequenceStress] = useState('0');
  const [withdrawalPct, setWithdrawalPct] = useState('4');
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [historyStatus, setHistoryStatus] = useState('Loading saved market history…');
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function loadHistory() {
      try {
        const [instruments, listings, prices] = await Promise.all([db.instruments.toArray(), db.listings.toArray(), db.marketPrices.toArray()]);
        const byInstrument = new Map(instruments.map(i => [i.id, i]));
        const series = assets.map(asset => {
          const normalize = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, '');
          const keys = [normalize(asset.name), normalize((asset as typeof asset & { ticker?: string }).ticker || '')];
          const listing = listings.find(l => keys.includes(normalize(l.symbol)) || keys.includes(normalize(byInstrument.get(l.instrumentId)?.name || '')));
          const rows = listing ? prices.filter(p => p.listingId === listing.id).sort((a, b) => a.date.localeCompare(b.date)) : [];
          return rows.map(p => ({ date: p.date.slice(0, 7), value: p.adjustedClose && p.adjustedClose > 0 ? p.adjustedClose : p.close }));
        });
        const periods = Array.from(new Set(series.flatMap(rows => rows.map(r => r.date)))).sort();
        const aligned = series.map(rows => {
          const byMonth = new Map(rows.map(r => [r.date, r.value]));
          let last = 0;
          return periods.map(p => { if (byMonth.has(p)) last = byMonth.get(p) || last; return last; });
        });
        const rows: HistoryRow[] = [];
        for (let i = 1; i < periods.length; i++) {
          const returns = aligned.map(p => p[i - 1] > 0 && p[i] > 0 ? p[i] / p[i - 1] - 1 : NaN);
          if (returns.filter(Number.isFinite).length >= Math.max(1, Math.ceil(assets.length * .6))) rows.push({ date: periods[i], returns });
        }
        if (!cancelled) { setHistory(rows); setHistoryStatus(rows.length ? rows.length + ' aligned monthly observations loaded from saved adjusted prices.' : 'No matching historical prices found; choose a statistical or parameterized model.'); }
      } catch (e) { if (!cancelled) setHistoryStatus('Could not load saved market data: ' + (e instanceof Error ? e.message : String(e))); }
      finally { if (!cancelled) setIsLoadingHistory(false); }
    }
    loadHistory();
    return () => { cancelled = true; };
  }, []);
  const totalWeight = assets.reduce((sum, a) => sum + a.weight, 0);
  const currentValue = Number(initialAmount) || 0;
  const valid = currentValue >= 0 && Number(cashflow) >= 0 && Number(years) >= 1 && Number(years) <= 60 && Number(runs) >= 100 && Number(runs) <= 20000 && totalWeight > 0;
  const normalizedAssets = assets.map(a => ({ ...a, weight: a.weight / totalWeight }));
  const runSimulation = () => {
    if (!valid) return;
    const count = clamp(Math.round(Number(runs)), 100, 20000);
    const duration = clamp(Math.round(Number(years)), 1, 60);
    const flowFrequency = Number(frequency);
    const amount = Number(cashflow);
    if (model === 'historical' && history.length < 12) { setResults(null); return; }
    const n = normalizedAssets.length;
    const correlationMatrix = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => {
      if (i === j) return 1;
      const pairs = history.map(row => [row.returns[i], row.returns[j]]).filter(pair => Number.isFinite(pair[0]) && Number.isFinite(pair[1]));
      if (pairs.length < 3) return 0;
      const mi = pairs.reduce((sum, pair) => sum + pair[0], 0) / pairs.length;
      const mj = pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length;
      const cov = pairs.reduce((sum, pair) => sum + (pair[0] - mi) * (pair[1] - mj), 0);
      const si = Math.sqrt(pairs.reduce((sum, pair) => sum + (pair[0] - mi) ** 2, 0));
      const sj = Math.sqrt(pairs.reduce((sum, pair) => sum + (pair[1] - mj) ** 2, 0));
      return si > 0 && sj > 0 ? clamp(cov / (si * sj), -.95, .95) : 0;
    }));
    setResults(Array.from({ length: count }, () => pathFor(duration, currentValue, amount, flowFrequency, inflationAdjusted, Number(inflation) || 0, normalizedAssets, model, distribution, clamp(Number(df) || 5, 3, 30), history, correlationMatrix, flowType, Number(withdrawalPct) || 0, Number(sequenceStress) || 0)));
  };

  const stats = useMemo(() => {
    if (!results?.length) return null;
    const nominal = results.map(r => r.ending);
    const real = results.map(r => r.realEnding);
    const drawdowns = results.map(r => r.maxDrawdown);
    const yearsCount = Math.max(...results.map(r => r.yearly.length)) - 1;
    const medianPath = Array.from({ length: yearsCount + 1 }, (_, year) => quantile(results.map(r => r.yearly[year] ?? 0), 0.5));
    const p10Path = Array.from({ length: yearsCount + 1 }, (_, year) => quantile(results.map(r => r.yearly[year] ?? 0), 0.1));
    const p90Path = Array.from({ length: yearsCount + 1 }, (_, year) => quantile(results.map(r => r.yearly[year] ?? 0), 0.9));
    return { nominal, real, drawdowns, medianPath, p10Path, p90Path, survival: results.filter(r => r.survived && r.ending > 0).length / results.length, lossProbability: results.filter(r => r.ending < currentValue).length / results.length, yearlyRows: Array.from({ length: yearsCount + 1 }, (_, y) => [String(y), ...[.1,.25,.5,.75,.9].map(p => euro(quantile(results.map(r => r.yearly[y] ?? 0), p)))]) };
  }, [results, initialAmount, years, currentValue]);

  const updateAsset = (index: number, field: 'name' | 'weight' | 'mean' | 'vol', value: string) => {
    setAssets(prev => prev.map((a, i) => i === index ? { ...a, [field]: field === 'name' ? value : Number(value) || 0 } : a));
  };
  const addAsset = () => { if (assets.length < 8) setAssets(prev => [...prev, { name: `Asset ${prev.length + 1}`, weight: 0, mean: 5, vol: 15 }]); };
  const chart = (p10: number[], p50: number[], p90: number[]) => {
    const width = 760, height = 250, pad = 36;
    const max = Math.max(1, ...p90);
    const x = (i: number) => pad + (width - 2 * pad) * i / Math.max(1, p50.length - 1);
    const y = (v: number) => height - pad - (height - 2 * pad) * v / max;
    const line = (values: number[]) => values.map((v, i) => `${i ? 'L' : 'M'} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
    const band = `${p90.map((v, i) => `${i ? 'L' : 'M'} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ')} ${p10.slice().reverse().map((v, j) => { const i = p10.length - 1 - j; return `L ${x(i).toFixed(1)} ${y(v).toFixed(1)}`; }).join(' ')} Z`;
    return <svg className="mc-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Monte Carlo portfolio projection chart">
      {[0, .25, .5, .75, 1].map(t => <g key={t}><line x1={pad} x2={width - pad} y1={y(max * t)} y2={y(max * t)} className="mc-gridline" /><text x={pad - 7} y={y(max * t) + 4} textAnchor="end" className="mc-axis-label">{euro(max * t)}</text></g>)}
      <path d={band} className="mc-range-band" />
      <path d={line(p90)} className="mc-line mc-line-high" />
      <path d={line(p50)} className="mc-line mc-line-median" />
      <path d={line(p10)} className="mc-line mc-line-low" />
      <text x={pad} y={height - 8} className="mc-axis-label">Year 0</text>
      <text x={width - pad} y={height - 8} textAnchor="end" className="mc-axis-label">Year {p50.length - 1}</text>
    </svg>;
  };

  return <div className="mc-page">
    <header className="mc-heading"><div><p className="mc-eyebrow">PLANNING & RISK</p><h2>Monte Carlo Simulator</h2><p>Explore thousands of possible portfolio outcomes instead of relying on a single forecast. {portfolioAssets.length ? `Linked to your portfolio: ${portfolioAssets.length} tracked assets.` : 'No tracked assets found yet; you can still model a hypothetical allocation.'}</p></div><span className="mc-pill">Stochastic projection</span></header>
    <div className="mc-layout">
      <section className="panel mc-config">
        <div className="mc-section-title"><div><h3>Simulation settings</h3><p>All amounts are in EUR. Assumptions are editable.</p></div></div>
        <div className="mc-fields">
          <label>Initial portfolio value<input type="number" min="0" step="100" value={initialAmount} onChange={e => setInitialAmount(e.target.value)} /></label>
          <label>Horizon (years)<input type="number" min="1" max="60" value={years} onChange={e => setYears(e.target.value)} /></label>
          <label>{flowType === 'contribution' ? 'Periodic contribution' : 'Periodic withdrawal'}<input type="number" min="0" step="100" value={cashflow} onChange={e => setCashflow(e.target.value)} /></label>
          <label>Cashflow frequency<select value={frequency} onChange={e => setFrequency(e.target.value)}><option value="1">Annually</option><option value="2">Semi-annually</option><option value="4">Quarterly</option><option value="12">Monthly</option></select></label>
          <label>Cashflow type<select value={flowType} onChange={e => setFlowType(e.target.value as 'contribution' | 'withdrawal')}><option value="contribution">Contributions</option><option value="withdrawal">Withdrawals</option><option value="percentage">Fixed percentage withdrawals</option></select></label>
          <label>Simulation paths<input type="number" min="100" max="20000" step="100" value={runs} onChange={e => setRuns(e.target.value)} /></label>
          <label>Expected inflation (%)<input type="number" min="-5" max="20" step="0.1" value={inflation} onChange={e => setInflation(e.target.value)} /></label>
          <label>Simulation model<select value={model} onChange={e => setModel(e.target.value as Model)}><option value="historical">Historical bootstrap</option><option value="statistical">Statistical returns</option><option value="parameterized">Parameterized returns</option></select></label>
          {model !== 'historical' && <label>Return distribution<select value={distribution} onChange={e => setDistribution(e.target.value as Distribution)}><option value="normal">Normal</option><option value="student">Student t (fat tails)</option></select></label>}
          {model !== 'historical' && distribution === 'student' && <label>Student t degrees of freedom<input type="number" min="3" max="30" value={df} onChange={e => setDf(e.target.value)} /></label>}
          <label>Worst return years first<select value={sequenceStress} onChange={e => setSequenceStress(e.target.value)}><option value="0">Off</option>{Array.from({ length: 10 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1} year(s)</option>)}</select></label>
          {flowType === 'percentage' && <label>Annual withdrawal (%)<input type="number" min="0" max="30" step="0.25" value={withdrawalPct} onChange={e => setWithdrawalPct(e.target.value)} /></label>}
          <label className="mc-checkbox"><input type="checkbox" checked={inflationAdjusted} onChange={e => setInflationAdjusted(e.target.checked)} /><span>Inflation-adjust cashflows</span></label>
        </div>
        <div className="mc-section-title mc-assets-title"><div><h3>Asset allocation & assumptions</h3><p>Weights are normalized automatically in the simulation.</p></div><button className="secondary-button" onClick={addAsset} disabled={assets.length >= 8}>+ Add asset</button></div>
        <div className="mc-table-wrap"><table className="mc-assets-table"><thead><tr><th>Asset class</th><th>Weight %</th><th>Mean return %</th><th>Volatility %</th></tr></thead><tbody>
          {assets.map((asset, i) => <tr key={i}><td><input aria-label={`Asset ${i + 1} name`} value={asset.name} onChange={e => updateAsset(i, 'name', e.target.value)} /></td><td><input aria-label={`Asset ${i + 1} weight`} type="number" min="0" max="100" value={asset.weight} onChange={e => updateAsset(i, 'weight', e.target.value)} /></td><td><input aria-label={`Asset ${i + 1} mean return`} type="number" min="-30" max="50" step="0.1" value={asset.mean} onChange={e => updateAsset(i, 'mean', e.target.value)} /></td><td><input aria-label={`Asset ${i + 1} volatility`} type="number" min="0" max="100" step="0.1" value={asset.vol} onChange={e => updateAsset(i, 'vol', e.target.value)} /></td></tr>)}
        </tbody></table></div>
        <div className="mc-allocation-foot"><span>Total entered allocation</span><strong className={Math.abs(totalWeight - 100) < 0.01 ? 'is-balanced' : ''}>{totalWeight.toFixed(1)}%</strong></div>
        <button className="primary-button mc-run-button" onClick={runSimulation} disabled={!valid || isLoadingHistory}><span>▶</span> Run {Number(runs).toLocaleString('en-GB')} simulations</button>
        {!valid && <p className="mc-validation">Enter a valid initial value, horizon, number of paths and positive total allocation.</p>}
        <p className="mc-history-status">{isLoadingHistory ? 'Loading market history…' : historyStatus}</p><p className="mc-disclaimer">Historical bootstrap samples aligned monthly returns from locally saved adjusted prices and preserves observed cross-asset co-movement. Statistical and parameterized models use the assumptions above. Results are hypothetical and exclude taxes and fees.</p>
      </section>
      <section className="mc-results">
        {!stats && <div className="panel mc-empty"><div className="mc-empty-icon">⌁</div><h3>Your projection starts here</h3><p>Set your assumptions and run the simulation to see a range of possible outcomes, portfolio survival and downside risk.</p><div className="mc-empty-stats"><span><strong>10th–90th</strong><small>Outcome range</small></span><span><strong>Median</strong><small>Central scenario</small></span><span><strong>5,000</strong><small>Paths by default</small></span></div></div>}
        {stats && <><div className="mc-result-header"><div><h3>Simulation results</h3><p>{results?.length.toLocaleString('en-GB')} independent paths · {years} years · nominal and inflation-adjusted values</p></div><button className="secondary-button" onClick={runSimulation}>↻ Re-run</button></div>
          <div className="mc-kpis">
            <div className="panel mc-kpi"><span>Median ending balance</span><strong>{euro(quantile(stats.nominal, .5))}</strong><small>Nominal value</small></div>
            <div className="panel mc-kpi"><span>10th percentile</span><strong>{euro(quantile(stats.nominal, .1))}</strong><small>Downside outcome</small></div>
            <div className="panel mc-kpi"><span>90th percentile</span><strong>{euro(quantile(stats.nominal, .9))}</strong><small>Upside outcome</small></div>
            <div className="panel mc-kpi"><span>{flowType === 'withdrawal' ? 'Withdrawal survival' : 'Ending above zero'}</span><strong>{pct(stats.survival)}</strong><small>{flowType === 'withdrawal' ? 'Paths funding all withdrawals' : 'Paths retaining a positive balance'}</small></div>
          </div>
          <div className="panel mc-chart-panel"><div className="mc-section-title"><div><h3>Portfolio balance over time</h3><p>10th–90th percentile range and median path</p></div></div>{chart(stats.p10Path, stats.medianPath, stats.p90Path)}<div className="mc-legend"><span><i className="mc-legend-low" />10th percentile</span><span><i className="mc-legend-median" />Median</span><span><i className="mc-legend-high" />90th percentile</span></div></div>
          <div className="panel mc-table-panel"><div className="mc-section-title"><div><h3>Portfolio value by year</h3><p>Percentile table of nominal year-end balances</p></div></div><table className="mc-summary-table"><thead><tr><th>Year</th><th>10th</th><th>25th</th><th>Median</th><th>75th</th><th>90th</th></tr></thead><tbody>{stats.yearlyRows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table></div>
          <div className="panel mc-table-panel"><div className="mc-section-title"><div><h3>Ending balance distribution</h3><p>Percentiles of all simulated portfolio paths</p></div></div><table className="mc-summary-table"><thead><tr><th>Metric</th><th>5th</th><th>10th</th><th>25th</th><th>50th</th><th>75th</th><th>90th</th><th>95th</th></tr></thead><tbody>
            <tr><td>Ending balance (nominal)</td>{[.05,.1,.25,.5,.75,.9,.95].map(p => <td key={p}>{euro(quantile(stats.nominal,p))}</td>)}</tr>
            <tr><td>Ending balance (real)</td>{[.05,.1,.25,.5,.75,.9,.95].map(p => <td key={p}>{euro(quantile(stats.real,p))}</td>)}</tr>
            <tr><td>Maximum drawdown</td>{[.05,.1,.25,.5,.75,.9,.95].map(p => <td key={p}>{pct(quantile(stats.drawdowns,p))}</td>)}</tr>
          </tbody></table></div>
        </>}
      </section>
    </div>
  </div>;
}
