import { useMemo, useState } from 'react';

type PortfolioAsset = { name: string; ticker: string; category: string; value: number };
type Props = { initialPortfolioValue: number; portfolioAssets: PortfolioAsset[] };
type PathSummary = { ending: number; realEnding: number; survived: boolean; maxDrawdown: number; yearly: number[] };

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
function pathFor(seed: number, years: number, start: number, cashflow: number, frequency: number, inflationAdjusted: boolean, inflation: number, assets: { weight: number; mean: number; vol: number }[], withdrawals: boolean): PathSummary {
  let balance = start;
  let peak = Math.max(start, 0);
  let maxDrawdown = 0;
  let cumulativeInflation = 1;
  const yearly: number[] = [start];
  let survived = true;
  // Independent simulated paths; asset returns are sampled per period and combined by allocation.
  for (let year = 1; year <= years; year++) {
    for (let period = 0; period < frequency; period++) {
      const periodReturns = assets.map(a => {
        const mu = Math.pow(1 + a.mean, 1 / frequency) - 1;
        const sigma = a.vol / Math.sqrt(frequency);
        return Math.max(-0.95, mu + sigma * randomNormal());
      });
      const portfolioReturn = assets.reduce((sum, a, i) => sum + a.weight * periodReturns[i], 0);
      balance = Math.max(0, balance * (1 + portfolioReturn));
      if (period === frequency - 1) cumulativeInflation *= Math.max(0.5, 1 + (inflation / 100));
      const flow = cashflow * (inflationAdjusted ? cumulativeInflation : 1);
      if (withdrawals) {
        balance = Math.max(0, balance - flow);
        if (balance <= 0) survived = false;
      } else balance += flow;
      peak = Math.max(peak, balance);
      if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - balance) / peak);
    }
    yearly.push(balance);
  }
  return { ending: balance, realEnding: balance / cumulativeInflation, survived, maxDrawdown, yearly };
}

export default function MonteCarloSimulator({ initialPortfolioValue, portfolioAssets }: Props) {
  const suggestedStart = Math.max(0, Math.round(initialPortfolioValue || 0));
  const [initialAmount, setInitialAmount] = useState(String(suggestedStart));
  const [cashflow, setCashflow] = useState('12000');
  const [flowType, setFlowType] = useState<'contribution' | 'withdrawal'>('contribution');
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
  const [hasRun, setHasRun] = useState(false);

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
    setResults(Array.from({ length: count }, (_, i) => pathFor(i, duration, currentValue, amount, flowFrequency, inflationAdjusted, Number(inflation) || 0, normalizedAssets, flowType === 'withdrawal')));
    setHasRun(true);
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
    return { nominal, real, drawdowns, medianPath, p10Path, p90Path, survival: results.filter(r => r.survived).length / results.length };
  }, [results]);

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
          <label>Cashflow type<select value={flowType} onChange={e => setFlowType(e.target.value as 'contribution' | 'withdrawal')}><option value="contribution">Contributions</option><option value="withdrawal">Withdrawals</option></select></label>
          <label>Simulation paths<input type="number" min="100" max="20000" step="100" value={runs} onChange={e => setRuns(e.target.value)} /></label>
          <label>Expected inflation (%)<input type="number" min="-5" max="20" step="0.1" value={inflation} onChange={e => setInflation(e.target.value)} /></label>
          <label className="mc-checkbox"><input type="checkbox" checked={inflationAdjusted} onChange={e => setInflationAdjusted(e.target.checked)} /><span>Inflation-adjust cashflows</span></label>
        </div>
        <div className="mc-section-title mc-assets-title"><div><h3>Asset allocation & assumptions</h3><p>Weights are normalized automatically in the simulation.</p></div><button className="secondary-button" onClick={addAsset} disabled={assets.length >= 8}>+ Add asset</button></div>
        <div className="mc-table-wrap"><table className="mc-assets-table"><thead><tr><th>Asset class</th><th>Weight %</th><th>Mean return %</th><th>Volatility %</th></tr></thead><tbody>
          {assets.map((asset, i) => <tr key={i}><td><input aria-label={`Asset ${i + 1} name`} value={asset.name} onChange={e => updateAsset(i, 'name', e.target.value)} /></td><td><input aria-label={`Asset ${i + 1} weight`} type="number" min="0" max="100" value={asset.weight} onChange={e => updateAsset(i, 'weight', e.target.value)} /></td><td><input aria-label={`Asset ${i + 1} mean return`} type="number" min="-30" max="50" step="0.1" value={asset.mean} onChange={e => updateAsset(i, 'mean', e.target.value)} /></td><td><input aria-label={`Asset ${i + 1} volatility`} type="number" min="0" max="100" step="0.1" value={asset.vol} onChange={e => updateAsset(i, 'vol', e.target.value)} /></td></tr>)}
        </tbody></table></div>
        <div className="mc-allocation-foot"><span>Total entered allocation</span><strong className={Math.abs(totalWeight - 100) < 0.01 ? 'is-balanced' : ''}>{totalWeight.toFixed(1)}%</strong></div>
        <button className="primary-button mc-run-button" onClick={runSimulation} disabled={!valid}><span>▶</span> Run {Number(runs).toLocaleString('en-GB')} simulations</button>
        {!valid && <p className="mc-validation">Enter a valid initial value, horizon, number of paths and positive total allocation.</p>}
        <p className="mc-disclaimer">Illustrative model, not a forecast or investment advice. Returns are simulated with a normal distribution; cross-asset correlations and taxes are not currently modeled.</p>
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
          <div className="panel mc-table-panel"><div className="mc-section-title"><div><h3>Ending balance distribution</h3><p>Percentiles of all simulated portfolio paths</p></div></div><table className="mc-summary-table"><thead><tr><th>Metric</th><th>10th</th><th>25th</th><th>50th</th><th>75th</th><th>90th</th></tr></thead><tbody>
            <tr><td>Ending balance (nominal)</td>{[.1,.25,.5,.75,.9].map(p => <td key={p}>{euro(quantile(stats.nominal,p))}</td>)}</tr>
            <tr><td>Ending balance (real)</td>{[.1,.25,.5,.75,.9].map(p => <td key={p}>{euro(quantile(stats.real,p))}</td>)}</tr>
            <tr><td>Maximum drawdown</td>{[.1,.25,.5,.75,.9].map(p => <td key={p}>{pct(quantile(stats.drawdowns,p))}</td>)}</tr>
          </tbody></table></div>
        </>}
      </section>
    </div>
  </div>;
}
