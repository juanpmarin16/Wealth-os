import { useEffect, useMemo, useState } from 'react';
import MarketDataImport from './MarketDataImport';
import MonteCarloSimulator from './MonteCarloSimulator';

type Asset = { id: string; name: string; ticker: string; symbol: string; category: string; weight: number; expectedReturn: number; volatility: number };
type Price = { date: string; close: number; adjustedClose?: number };
type Series = { asset: Asset; prices: Price[] };
type Page = 'Portfolio Builder' | 'Portfolio Analysis' | 'Monte Carlo' | 'Risk Analysis' | 'Optimization' | 'Market Data';

const API = 'https://wealth-os-market-data.onrender.com';
const DEFAULTS: Asset[] = [
  { id: '1', name: 'Vanguard FTSE All-World ETF', ticker: 'VGWL', symbol: 'VGWL.DE', category: 'Equity', weight: 40, expectedReturn: 7, volatility: 16 },
  { id: '2', name: 'Invesco Nasdaq-100', ticker: 'EQQQ', symbol: 'EQQQ.DE', category: 'Equity', weight: 30, expectedReturn: 9, volatility: 22 },
  { id: '3', name: 'Bitcoin', ticker: 'BTC', symbol: 'BTC-USD', category: 'Crypto', weight: 20, expectedReturn: 12, volatility: 65 },
  { id: '4', name: 'L&G Global Quality Dividends ETF', ticker: 'LDGL', symbol: 'LDGL.L', category: 'Equity', weight: 10, expectedReturn: 6, volatility: 13 },
];
const money = (v: number) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(Number.isFinite(v) ? v : 0);
const pct = (v: number | null, d = 2) => v === null || !Number.isFinite(v) ? '—' : (v * 100).toFixed(d) + '%';
const avg = (a: number[]) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const stdev = (a: number[]) => a.length > 1 ? Math.sqrt(a.reduce((s, v) => s + (v - avg(a)) ** 2, 0) / (a.length - 1)) : 0;
const quantile = (values: number[], p: number) => { const a = [...values].sort((x, y) => x - y); if (!a.length) return 0; const x = (a.length - 1) * p, lo = Math.floor(x); return a[lo] + ((a[Math.min(lo + 1, a.length - 1)] - a[lo]) * (x - lo)); };
const uid = () => Math.random().toString(36).slice(2, 10);
const SYMBOLS: Record<string, string> = { VGWL: 'VGWL.DE', VWCE: 'VWCE.DE', VWRL: 'VWRL.DE', EQQQ: 'EQQQ.DE', LDGL: 'LDGL.L', BTC: 'BTC-USD', ETH: 'ETH-USD', MSTR: 'MSTR', SGLN: 'SGLN.L', IGLN: 'IGLN.L', VUSA: 'VUSA.DE', CSPX: 'CSPX.AS', AGGH: 'AGGH.DE', XEON: 'XEON.DE' };

function loadAssets(): Asset[] {
  try { const raw = localStorage.getItem('wealth-os-lab-assets'); const parsed = raw ? JSON.parse(raw) : null; if (Array.isArray(parsed) && parsed.length) return parsed; } catch { /* use defaults */ }
  return DEFAULTS;
}
function covariance(a: number[], b: number[]) { const n = Math.min(a.length, b.length); if (n < 3) return 0; const x = a.slice(-n), y = b.slice(-n), mx = avg(x), my = avg(y); return x.reduce((s, v, i) => s + (v - mx) * (y[i] - my), 0) / (n - 1); }
function weightedStats(returns: number[][], weights: number[]) {
  const n = Math.min(...returns.map(r => r.length)); if (!Number.isFinite(n) || n < 2) return { daily: [] as number[], annualReturn: null as number | null, vol: null as number | null, sharpe: null as number | null, sortino: null as number | null, maxDD: null as number | null };
  const daily = Array.from({ length: n }, (_, i) => returns.reduce((s, r, j) => s + (r[r.length - n + i] || 0) * weights[j], 0));
  const mean = avg(daily), vol = stdev(daily) * Math.sqrt(252), annualReturn = Math.pow(Math.max(.000001, daily.reduce((p, r) => p * (1 + r), 1)), 252 / n) - 1;
  const downside = Math.sqrt(avg(daily.filter(r => r < 0).map(r => r * r))) * Math.sqrt(252);
  let nav = 1, peak = 1, maxDD = 0; daily.forEach(r => { nav *= 1 + r; peak = Math.max(peak, nav); maxDD = Math.max(maxDD, 1 - nav / peak); });
  return { daily, annualReturn, vol, sharpe: vol ? (mean * 252 - .02) / vol : null, sortino: downside ? (mean * 252 - .02) / downside : null, maxDD };
}
function LineChart({ values, label = 'Portfolio growth' }: { values: number[]; label?: string }) {
  if (values.length < 2) return <div className="empty-state">Import historical prices to display this chart.</div>;
  const w = 900, h = 260, pad = 28, min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const points = values.map((v, i) => `${pad + i / (values.length - 1) * (w - 2 * pad)},${h - pad - (v - min) / span * (h - 2 * pad)}`).join(' ');
  return <div className="chart-wrap"><svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label}><line x1={pad} y1={h-pad} x2={w-pad} y2={h-pad} className="chart-axis"/><polyline points={points} className="chart-line" fill="none"/></svg></div>;
}
function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) { return <div className="metric-card"><span>{label}</span><strong>{value}</strong>{hint && <small>{hint}</small>}</div>; }

export default function PortfolioWorkspace() {
  const [page, setPage] = useState<Page>('Portfolio Builder');
  const [assets, setAssets] = useState<Asset[]>(loadAssets);
  const [initialValue, setInitialValue] = useState('100000');
  const [contribution, setContribution] = useState('1000');
  const [horizon, setHorizon] = useState('20');
  const [baseCurrency] = useState('EUR');
  const [series, setSeries] = useState<Series[]>([]);
  const [loading, setLoading] = useState(false);
  const [dataError, setDataError] = useState('');
  const [dataStatus, setDataStatus] = useState('Historical data has not been loaded yet.');
  const [varLevel, setVarLevel] = useState<'95' | '99'>('95');
  const [varPeriod, setVarPeriod] = useState<'daily' | 'monthly' | 'annual'>('daily');
  const [stress, setStress] = useState('2008');
  const [optimization, setOptimization] = useState<{ weights: number[]; ret: number; vol: number; sharpe: number }[]>([]);
  const [minimumVariance, setMinimumVariance] = useState<{ weights: number[]; ret: number; vol: number; sharpe: number } | null>(null);
  const totalWeight = assets.reduce((s, a) => s + Math.max(0, Number(a.weight) || 0), 0);
  const weights = assets.map(a => totalWeight ? Math.max(0, a.weight) / totalWeight : 0);
  const validAssets = assets.filter(a => a.ticker.trim() && a.weight > 0);
  const nav = useMemo(() => {
    if (!series.length || !validAssets.length) return [];
    const aligned = series.map(s => new Map(s.prices.map(p => [p.date, p.adjustedClose && p.adjustedClose > 0 ? p.adjustedClose : p.close])));
    const dates = [...new Set(series.flatMap(s => s.prices.map(p => p.date)))].filter(date => series.every(s => s.prices.some(p => p.date === date))).sort();
    const last: number[] = Array(series.length).fill(0);
    const points: number[] = [];
    dates.forEach(date => {
      let value = 0, used = 0;
      series.forEach((s, i) => { const p = aligned[i].get(date); if (p && p > 0) last[i] = p; if (last[i] > 0) { value += weights[assets.findIndex(a => a.ticker === s.asset.ticker)] * last[i] / (s.prices[0]?.adjustedClose || s.prices[0]?.close || last[i]); used += weights[assets.findIndex(a => a.ticker === s.asset.ticker)]; } });
      if (used > 0) points.push(value / used * 100);
    });
    return points;
  }, [series, assets, weights.join('|')]);
  const returnArrays = useMemo(() => {
    if (!series.length) return [] as number[][];
    const allDates = [...new Set(series.flatMap(s => s.prices.map(p => p.date)))].filter(date => series.every(s => s.prices.some(p => p.date === date))).sort();
    const priceMaps = series.map(s => new Map(s.prices.map(p => [p.date, p.adjustedClose && p.adjustedClose > 0 ? p.adjustedClose : p.close])));
    const lastPrices = Array(series.length).fill(0) as number[];
    const previousPrices = Array(series.length).fill(0) as number[];
    const aligned = series.map(() => [] as number[]);
    allDates.forEach(date => {
      priceMaps.forEach((map, i) => { const value = map.get(date); if (value && value > 0) lastPrices[i] = value; });
      if (lastPrices.every(value => value > 0)) {
        lastPrices.forEach((value, i) => { if (previousPrices[i] > 0) aligned[i].push(value / previousPrices[i] - 1); previousPrices[i] = value; });
      }
    });
    return aligned;
  }, [series]);
  const portfolioStats = useMemo(() => returnArrays.length && returnArrays.every(r => r.length >= 2) ? weightedStats(returnArrays, series.map(s => weights[assets.findIndex(a => a.ticker === s.asset.ticker)])) : null, [series, assets, weights.join('|')]);
  const dailyReturns = portfolioStats?.daily ?? [];
  const scale = varPeriod === 'daily' ? 1 : varPeriod === 'monthly' ? Math.sqrt(21) : Math.sqrt(252);
  const varLoss = dailyReturns.length ? Math.max(0, -quantile(dailyReturns, 1 - Number(varLevel) / 100) * scale) : null;
  const cvarLoss = dailyReturns.length ? Math.max(0, -avg(dailyReturns.filter(r => r <= quantile(dailyReturns, 1 - Number(varLevel) / 100))) * scale) : null;
  const corrMatrix = useMemo(() => returnArrays.map(a => returnArrays.map(b => { const c = covariance(a, b); return stdev(a) && stdev(b) ? c / (stdev(a) * stdev(b)) : 0; })), [series]);
  useEffect(() => { try { localStorage.setItem('wealth-os-lab-assets', JSON.stringify(assets)); } catch { /* local save is optional */ } }, [assets]);

  function updateAsset(id: string, key: 'name' | 'ticker' | 'symbol' | 'category', value: string) {
    setAssets(prev => prev.map(a => a.id === id ? { ...a, [key]: value } : a));
  }
  function updateNumber(id: string, key: 'weight' | 'expectedReturn' | 'volatility', value: string) {
    setAssets(prev => prev.map(a => a.id === id ? { ...a, [key]: Number(value) || 0 } : a));
  }
  function addAsset() { if (assets.length < 12) setAssets(prev => [...prev, { id: uid(), name: 'New Asset', ticker: '', symbol: '', category: 'Equity', weight: 0, expectedReturn: 7, volatility: 18 }]); }
  async function loadMarketData() {
    setLoading(true); setDataError('');
    try {
      const fetched = await Promise.all(validAssets.map(async asset => {
        const symbol = asset.symbol.trim() || SYMBOLS[asset.ticker.toUpperCase()] || asset.ticker.toUpperCase();
        const response = await fetch(`${API}/api/saved-prices?symbol=${encodeURIComponent(symbol)}`, { headers: { Accept: 'application/json' } });
        const payload = await response.json();
        if (!response.ok) throw new Error(`${asset.ticker}: ${payload?.detail || response.statusText}`);
        const prices = Array.isArray(payload.prices) ? payload.prices.filter((p: Price) => p && typeof p.date === 'string' && Number.isFinite(p.close) && p.close > 0) : [];
        return { asset: { ...asset, symbol }, prices } as Series;
      }));
      setSeries(fetched); const count = fetched.reduce((s, x) => s + x.prices.length, 0);
      setDataStatus(count ? `${count.toLocaleString('en-GB')} saved daily price records loaded across ${fetched.filter(x => x.prices.length).length} assets.` : 'No saved prices were found for this allocation.');
      if (!count) setDataError('No historical data found. Open Market Data and import prices first.');
    } catch (e) { setDataError(e instanceof Error ? e.message : String(e)); setDataStatus('Market data could not be loaded.'); }
    finally { setLoading(false); }
  }
  function runOptimization() {
    if (returnArrays.length < 2 || returnArrays.some(r => r.length < 30)) { setDataError('Load at least 30 daily observations for two or more assets before optimization.'); return; }
    const candidates = Array.from({ length: 5000 }, () => {
      const raw = assets.map(() => Math.random()); const sum = raw.reduce((a,b) => a+b,0); const w = raw.map(x => x/sum);
      const stats = weightedStats(returnArrays, series.map(s => w[assets.findIndex(a => a.ticker === s.asset.ticker)]));
      return { weights: w, ret: stats.annualReturn || 0, vol: stats.vol || 0, sharpe: stats.sharpe || 0 };
    });
    const lowestRisk = [...candidates].sort((a,b) => a.vol-b.vol)[0] || null;
    setMinimumVariance(lowestRisk);
    setOptimization(candidates.sort((a,b) => b.sharpe-a.sharpe).slice(0, 20)); setDataError('');
  }
  const stressByClass: Record<string, Record<string, number>> = {
    '2008': { Equity: -.38, Bond: -.05, Crypto: -.70, Commodity: -.25, 'Real Estate': -.40, Cash: 0, Other: -.25 },
    '2020': { Equity: -.34, Bond: .02, Crypto: -.50, Commodity: -.12, 'Real Estate': -.30, Cash: 0, Other: -.20 },
    '2022': { Equity: -.19, Bond: -.15, Crypto: -.65, Commodity: .05, 'Real Estate': -.25, Cash: 0, Other: -.20 },
    custom: { Equity: -.15, Bond: -.10, Crypto: -.35, Commodity: -.05, 'Real Estate': -.15, Cash: 0, Other: -.10 },
  };
  const stressImpact = assets.reduce((sum, asset, i) => sum + weights[i] * (stressByClass[stress]?.[asset.category] ?? stressByClass[stress]?.Other ?? 0), 0);
  const historicalIndex = nav.length ? nav.map(v => v / nav[0] * 100) : [];
  const activePage = (p: Page) => setPage(p);

  return <div className="wealth-app">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">W</div><div><b>WEALTH OS</b><small>PORTFOLIO ANALYTICS</small></div></div>
      <div className="nav-caption">WORKSPACE</div>
      {(['Portfolio Builder','Portfolio Analysis','Monte Carlo','Risk Analysis','Optimization','Market Data'] as Page[]).map((p,i) => <button key={p} className={page===p?'nav-item active':'nav-item'} onClick={()=>activePage(p)}><span className="nav-icon">{['◫','⌁','◎','◈','⤢','▤'][i]}</span>{p}</button>)}
      <div className="sidebar-bottom"><span className="status-dot"/> Local workspace <small>Research environment</small></div>
    </aside>
    <main className="main-area">
      <header className="topbar"><div><span className="crumb">WEALTH OS</span><span className="crumb-sep">/</span><strong>{page}</strong></div><div className="topbar-right"><span className="currency-tag">EUR BASE</span><span className="user-chip">ANALYTICS</span></div></header>
      <div className="content-area">
        {page === 'Portfolio Builder' && <><div className="page-heading"><div><div className="eyebrow">PORTFOLIO CONSTRUCTION</div><h1>Portfolio Builder</h1><p>Build and save hypothetical asset allocations. No personal transactions or brokerage data required.</p></div><button className="button button-secondary" onClick={()=>setAssets(DEFAULTS)}>Reset example</button></div>
          <section className="panel builder-panel"><div className="section-heading"><div><h2>Asset allocation</h2><p>Add instruments and define target portfolio weights.</p></div><button className="button button-primary" onClick={addAsset} disabled={assets.length>=12}>+ Add asset</button></div>
            <div className="table-scroll"><table className="data-table"><thead><tr><th>Asset name</th><th>Ticker</th><th>Market symbol</th><th>Asset class</th><th>Weight</th><th>Expected return</th><th>Volatility</th><th/></tr></thead><tbody>{assets.map(a=><tr key={a.id}><td><input value={a.name} onChange={e=>updateAsset(a.id,'name',e.target.value)}/></td><td><input value={a.ticker} onChange={e=>updateAsset(a.id,'ticker',e.target.value.toUpperCase())}/></td><td><input value={a.symbol} placeholder={SYMBOLS[a.ticker.toUpperCase()]||'Yahoo symbol'} onChange={e=>updateAsset(a.id,'symbol',e.target.value.toUpperCase())}/></td><td><select value={a.category} onChange={e=>updateAsset(a.id,'category',e.target.value)}>{['Equity','Bond','Crypto','Commodity','Real Estate','Cash','Other'].map(c=><option key={c}>{c}</option>)}</select></td><td><div className="weight-input"><input type="number" min="0" max="100" step=".1" value={a.weight} onChange={e=>updateNumber(a.id,'weight',e.target.value)}/><span>%</span></div></td><td><div className="weight-input"><input type="number" step=".1" value={a.expectedReturn} onChange={e=>updateNumber(a.id,'expectedReturn',e.target.value)}/><span>%</span></div></td><td><div className="weight-input"><input type="number" min="0" step=".1" value={a.volatility} onChange={e=>updateNumber(a.id,'volatility',e.target.value)}/><span>%</span></div></td><td><button className="icon-button danger" onClick={()=>setAssets(prev=>prev.filter(x=>x.id!==a.id))} aria-label="Remove asset">×</button></td></tr>)}</tbody></table></div>
            <div className="allocation-footer"><div><span>Total allocation</span><strong className={Math.abs(totalWeight-100)<.01?'good-text':'warning-text'}>{totalWeight.toFixed(1)}%</strong></div><div className="allocation-bar">{assets.map(a=><i key={a.id} style={{width:`${totalWeight?Math.max(0,a.weight)/totalWeight*100:0}%`}} title={a.ticker}/>)}</div><small>{Math.abs(totalWeight-100)<.01?'Allocation is fully invested.':'Weights are normalized for calculations; adjust to 100% for clarity.'}</small></div>
          </section>
          <div className="builder-bottom"><section className="panel assumptions-panel"><div className="section-heading"><div><h2>Investment assumptions</h2><p>Inputs for forward-looking projections.</p></div></div><div className="form-grid"><label>Initial investment ({baseCurrency})<input type="number" min="0" value={initialValue} onChange={e=>setInitialValue(e.target.value)}/></label><label>Monthly contribution ({baseCurrency})<input type="number" min="0" value={contribution} onChange={e=>setContribution(e.target.value)}/></label><label>Investment horizon (years)<input type="number" min="1" max="60" value={horizon} onChange={e=>setHorizon(e.target.value)}/></label></div></section>
            <section className="panel allocation-summary"><div className="section-heading"><div><h2>Portfolio summary</h2><p>Current model configuration.</p></div></div><Metric label="Assets" value={String(validAssets.length)}/><Metric label="Initial capital" value={money(Number(initialValue)||0)}/><Metric label="Monthly contribution" value={money(Number(contribution)||0)}/><button className="button button-primary full-width" onClick={()=>setPage('Portfolio Analysis')}>Analyze portfolio <span>→</span></button></section></div>
        </>}
        {page === 'Portfolio Analysis' && <><div className="page-heading"><div><div className="eyebrow">HISTORICAL PERFORMANCE</div><h1>Portfolio Analysis</h1><p>Historical portfolio performance based on saved adjusted closing prices.</p></div><button className="button button-primary" onClick={loadMarketData} disabled={loading}>{loading?'Loading…':'↻ Load market data'}</button></div>
          {dataError&&<div className="alert">{dataError}</div>}<div className="data-status">{dataStatus}</div>
          <div className="metric-grid"><Metric label="Annualized return" value={pct(portfolioStats?.annualReturn??null)}/><Metric label="Annualized volatility" value={pct(portfolioStats?.vol??null)}/><Metric label="Sharpe ratio" value={portfolioStats?.sharpe?.toFixed(2)??'—'} hint="Risk-free rate: 2%"/><Metric label="Maximum drawdown" value={pct(portfolioStats?.maxDD??null)}/></div>
          <section className="panel"><div className="section-heading"><div><h2>Growth of 100</h2><p>Weighted portfolio index, normalized to 100 at inception.</p></div></div><LineChart values={historicalIndex}/></section>
          <section className="panel"><div className="section-heading"><div><h2>Asset performance</h2><p>Daily price history currently loaded from the durable archive.</p></div></div><div className="table-scroll"><table className="data-table"><thead><tr><th>Asset</th><th>Observations</th><th>First date</th><th>Last date</th><th>Period return</th><th>Weight</th></tr></thead><tbody>{series.map(s=><tr key={s.asset.id}><td>{s.asset.name} <small>({s.asset.ticker})</small></td><td>{s.prices.length.toLocaleString('en-GB')}</td><td>{s.prices[0]?.date||'—'}</td><td>{s.prices[s.prices.length-1]?.date||'—'}</td><td>{s.prices.length>1?pct((s.prices[s.prices.length-1].adjustedClose||s.prices[s.prices.length-1].close)/(s.prices[0].adjustedClose||s.prices[0].close)-1):'—'}</td><td>{pct(weights[assets.findIndex(a=>a.id===s.asset.id)])}</td></tr>)}</tbody></table></div></section>
        </>}
        {page === 'Monte Carlo' && <><div className="page-heading"><div><div className="eyebrow">FORWARD-LOOKING SIMULATION</div><h1>Monte Carlo</h1><p>Simulate a distribution of possible future portfolio outcomes.</p></div></div><MonteCarloSimulator key={assets.map(a=>a.ticker+':'+a.weight).join('|')} initialPortfolioValue={Number(initialValue)||0} horizonYears={Number(horizon)||20} monthlyContribution={Number(contribution)||0} portfolioAssets={assets.map(a=>({name:a.name,ticker:a.ticker,category:a.category,value:a.weight,expectedReturn:a.expectedReturn,volatility:a.volatility}))}/></>}
        {page === 'Risk Analysis' && <><div className="page-heading"><div><div className="eyebrow">DOWNSIDE & RISK METRICS</div><h1>Risk Analysis</h1><p>Historical loss distribution and portfolio risk diagnostics.</p></div><button className="button button-primary" onClick={loadMarketData} disabled={loading}>{loading?'Loading…':'↻ Load market data'}</button></div>{dataError&&<div className="alert">{dataError}</div>}<div className="metric-grid"><Metric label="Volatility" value={pct(portfolioStats?.vol??null)}/><Metric label="Sharpe ratio" value={portfolioStats?.sharpe?.toFixed(2)??'—'}/><Metric label="Sortino ratio" value={portfolioStats?.sortino?.toFixed(2)??'—'}/><Metric label="Maximum drawdown" value={pct(portfolioStats?.maxDD??null)}/></div>
          <section className="panel"><div className="section-heading"><div><h2>Value at Risk & Expected Shortfall</h2><p>Historical simulation method; losses shown as positive percentages.</p></div></div><div className="risk-controls"><label>Confidence level<select value={varLevel} onChange={e=>setVarLevel(e.target.value as '95'|'99')}><option value="95">95%</option><option value="99">99%</option></select></label><label>Holding period<select value={varPeriod} onChange={e=>setVarPeriod(e.target.value as 'daily'|'monthly'|'annual')}><option value="daily">Daily</option><option value="monthly">Monthly (21 trading days)</option><option value="annual">Annual (252 trading days)</option></select></label></div><div className="metric-grid two"><Metric label={`Historical VaR ${varLevel}`} value={pct(varLoss)}/><Metric label={`Historical CVaR ${varLevel}`} value={pct(cvarLoss)} hint="Average loss beyond VaR threshold"/></div><p className="method-note">Monthly and annual VaR are scaled from daily historical returns using the square-root-of-time rule. This is an approximation and may understate tail risk.</p></section>
          <section className="panel"><div className="section-heading"><div><h2>Correlation matrix</h2><p>Daily return correlations across selected assets.</p></div></div><div className="table-scroll"><table className="data-table matrix"><thead><tr><th>Asset</th>{series.map(s=><th key={s.asset.id}>{s.asset.ticker}</th>)}</tr></thead><tbody>{series.map((s,i)=><tr key={s.asset.id}><th>{s.asset.ticker}</th>{series.map((t,j)=><td key={t.asset.id} style={{background:`rgba(91,126,220,${Math.abs(corrMatrix[i]?.[j]||0)*.24})`}}>{corrMatrix[i]?.[j]?.toFixed(2)??'—'}</td>)}</tr>)}</tbody></table></div></section>
          <section className="panel"><div className="section-heading"><div><h2>Historical stress scenarios</h2><p>Illustrative shocks applied to each asset class. Not a replay of exact daily historical returns.</p></div></div><label className="stress-select">Scenario<select value={stress} onChange={e=>setStress(e.target.value)}><option value="2008">Global Financial Crisis (2008)</option><option value="2020">COVID-19 shock (2020)</option><option value="2022">Rate & inflation shock (2022)</option><option value="custom">Custom severe drawdown</option></select></label><div className="stress-result"><span>Estimated portfolio shock</span><strong className={stressImpact<0?'negative':''}>{pct(stressImpact)}</strong><small>Illustrative proxy based on position weights and broad asset-class shocks.</small></div></section>
        </>}
        {page === 'Optimization' && <><div className="page-heading"><div><div className="eyebrow">MEAN-VARIANCE FRAMEWORK</div><h1>Portfolio Optimization</h1><p>Explore simulated allocations using historical asset returns.</p></div><button className="button button-primary" onClick={runOptimization}>Run 5,000 portfolios</button></div>{dataError&&<div className="alert">{dataError}</div>}<div className="panel"><div className="section-heading"><div><h2>Optimization results</h2><p>5,000 random long-only allocations; top Sharpe portfolios and the minimum-volatility candidate. 2% risk-free rate.</p></div></div>{optimization.length===0?<div className="empty-state">Load historical data in Portfolio Analysis, then run the optimizer. Results are estimates, not guaranteed optimal allocations.</div>:<><div className="metric-grid two"><Metric label="Maximum Sharpe candidate" value={optimization[0]?.sharpe.toFixed(2)||'—'} hint="Best sampled risk-adjusted allocation"/><Metric label="Minimum volatility candidate" value={minimumVariance?pct(minimumVariance.vol):'—'} hint="Lowest sampled annualized volatility"/></div><div className="table-scroll"><table className="data-table"><thead><tr><th>Rank</th><th>Expected annual return</th><th>Annual volatility</th><th>Sharpe</th>{assets.map(a=><th key={a.id}>{a.ticker||a.name}</th>)}</tr></thead><tbody>{optimization.map((o,i)=><tr key={i}><td>{i+1}</td><td>{pct(o.ret)}</td><td>{pct(o.vol)}</td><td>{o.sharpe.toFixed(2)}</td>{o.weights.map((w,j)=><td key={j}>{pct(w)}</td>)}</tr>)}</tbody></table></div></>}</div></>}
        {page === 'Market Data' && <><div className="page-heading"><div><div className="eyebrow">MARKET DATA INFRASTRUCTURE</div><h1>Market Data</h1><p>Import full historical price series and maintain the durable market archive.</p></div></div><MarketDataImport assets={assets.map(a=>({id:a.id,name:a.name,ticker:a.ticker,category:a.category}))}/><section className="panel market-help"><h2>Supported market symbols</h2><p>Use Yahoo Finance symbols in the Market Symbol column in Portfolio Builder. Examples: VWCE.DE, VGWL.DE, EQQQ.DE, BTC-USD, ETH-USD, LDGL.L. Data is retrieved from the existing Wealth OS market-data API and stored in the connected archive when configured.</p><button className="button button-secondary" onClick={()=>setPage('Portfolio Analysis')}>Back to portfolio analysis</button></section></>}
      </div>
      <footer className="app-footer">WEALTH OS · PORTFOLIO ANALYTICS & SIMULATION <span>Hypothetical analysis only · Not investment advice</span></footer>
    </main>
  </div>;
}
