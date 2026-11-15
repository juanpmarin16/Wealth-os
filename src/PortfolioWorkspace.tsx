import { useEffect, useMemo, useState } from 'react';
import MarketDataImport from './MarketDataImport';
import MonteCarloSimulator from './MonteCarloSimulator';
import {
  alignDailyAssetReturns,
  calculatePortfolioStats,
  calculateHistoricalTailRisk,
  correlationMatrix,
  rollingPortfolioReturns,
  calculateBenchmarkMetrics,
} from './portfolioAnalyticsEngine';

type Asset = { id: string; name: string; ticker: string; symbol: string; category: string; weight: number; expectedReturn: number; volatility: number };
type Price = { date: string; close: number; adjustedClose?: number; currency?: string };
type Series = { asset: Asset; prices: Price[] };
type Page = 'Portfolio Builder' | 'Portfolio Analysis' | 'Monte Carlo' | 'Risk Analysis' | 'Optimization' | 'Market Data';
type FxPoint = { date: string; value: number };

const API = 'https://wealth-os-market-data.onrender.com';
const DEFAULTS: Asset[] = [
  { id: '1', name: 'Vanguard FTSE All-World ETF', ticker: 'VGWL', symbol: 'VGWL.DE', category: 'Equity', weight: 40, expectedReturn: 7, volatility: 16 },
  { id: '2', name: 'Invesco Nasdaq-100', ticker: 'EQQQ', symbol: 'EQQQ.DE', category: 'Equity', weight: 30, expectedReturn: 9, volatility: 22 },
  { id: '3', name: 'Bitcoin', ticker: 'BTC', symbol: 'BTC-USD', category: 'Crypto', weight: 20, expectedReturn: 12, volatility: 65 },
  { id: '4', name: 'L&G Global Quality Dividends ETF', ticker: 'LDGL', symbol: 'LDGL.L', category: 'Equity', weight: 10, expectedReturn: 6, volatility: 13 },
];
const money = (v: number) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(Number.isFinite(v) ? v : 0);
const pct = (v: number | null, d = 2) => v === null || !Number.isFinite(v) ? '—' : (v * 100).toFixed(d) + '%';
const uid = () => Math.random().toString(36).slice(2, 10);
const SYMBOLS: Record<string, string> = { VGWL: 'VGWL.DE', VWCE: 'VWCE.DE', VWRL: 'VWRL.DE', EQQQ: 'EQQQ.DE', LDGL: 'LDGL.L', BTC: 'BTC-USD', ETH: 'ETH-USD', MSTR: 'MSTR', SGLN: 'SGLN.L', IGLN: 'IGLN.L', VUSA: 'VUSA.DE', CSPX: 'CSPX.AS', AGGH: 'AGGH.DE', XEON: 'XEON.DE' };

async function loadFxHistory(currency: string): Promise<FxPoint[]> {
  const symbol = `EUR${currency}=X`;
  const saved = await fetch(`${API}/api/saved-prices?symbol=${encodeURIComponent(symbol)}`, { headers: { Accept: 'application/json' } });
  const savedPayload = await saved.json().catch(() => null);
  if (saved.ok && Array.isArray(savedPayload?.prices) && savedPayload.prices.length) {
    return savedPayload.prices.filter((p: any) => typeof p.date === 'string' && Number.isFinite(p.close) && p.close > 0)
      .map((p: any) => ({ date: p.date, value: p.adjustedClose > 0 ? p.adjustedClose : p.close })).sort((a: FxPoint, b: FxPoint) => a.date.localeCompare(b.date));
  }
  const response = await fetch(`${API}/api/history?symbol=${encodeURIComponent(symbol)}&period=max`, { headers: { Accept: 'application/json' } });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(payload?.prices) || !payload.prices.length) throw new Error(`Historical EUR/${currency} FX rates are unavailable. Cannot calculate a reliable EUR portfolio return.`);
  const prices = payload.prices.filter((p: any) => typeof p.date === 'string' && Number.isFinite(p.close) && p.close > 0).sort((a: any, b: any) => a.date.localeCompare(b.date));
  const persist = await fetch(`${API}/api/saved-prices`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ symbol, currency: payload.currency || currency, prices }),
  });
  if (!persist.ok) throw new Error(`Could not archive historical EUR/${currency} FX rates.`);
  return prices.map((p: any) => ({ date: p.date, value: p.adjustedClose > 0 ? p.adjustedClose : p.close })).sort((a: FxPoint, b: FxPoint) => a.date.localeCompare(b.date));
}
function latestFxRate(points: FxPoint[], date: string): number | null {
  let low = 0, high = points.length - 1, found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (points[mid].date <= date) { found = mid; low = mid + 1; } else high = mid - 1;
  }
  if (found < 0) return null;
  const age = (Date.parse(date + 'T00:00:00Z') - Date.parse(points[found].date + 'T00:00:00Z')) / 86400000;
  return age <= 5 ? points[found].value : null;
}
function latestPriceAt(points: Price[], date: string): number | null {
  let low = 0, high = points.length - 1, found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (points[mid].date <= date) { found = mid; low = mid + 1; } else high = mid - 1;
  }
  if (found < 0) return null;
  const age = (Date.parse(date + 'T00:00:00Z') - Date.parse(points[found].date + 'T00:00:00Z')) / 86400000;
  if (age > 5) return null;
  const price = points[found];
  return price.adjustedClose && price.adjustedClose > 0 ? price.adjustedClose : price.close;
}
function loadAssets(): Asset[] {
  try { const raw = localStorage.getItem('wealth-os-lab-assets'); const parsed = raw ? JSON.parse(raw) : null; if (Array.isArray(parsed) && parsed.length) return parsed; } catch { /* use defaults */ }
  return DEFAULTS;
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
  const [benchmarkId, setBenchmarkId] = useState(() => loadAssets()[0]?.id || '');
  const [loading, setLoading] = useState(false);
  const [dataError, setDataError] = useState('');
  const [dataStatus, setDataStatus] = useState('Historical data has not been loaded yet.');
  const [varLevel, setVarLevel] = useState<'95' | '99'>('95');
  const [varPeriod, setVarPeriod] = useState<'daily' | 'monthly' | 'annual'>('daily');
  const [rebalancing, setRebalancing] = useState<'monthly' | 'annual' | 'none'>('annual');
  const [stress, setStress] = useState('2008');
  const [optimization, setOptimization] = useState<{ weights: number[]; ret: number; vol: number; sharpe: number }[]>([]);
  const [minimumVariance, setMinimumVariance] = useState<{ weights: number[]; ret: number; vol: number; sharpe: number } | null>(null);
  const totalWeight = assets.reduce((s, a) => s + Math.max(0, Number(a.weight) || 0), 0);
  const weights = assets.map(a => totalWeight ? Math.max(0, a.weight) / totalWeight : 0);
  const validAssets = assets.filter(a => a.ticker.trim() && a.weight > 0);
  const returnRows = useMemo(() => alignDailyAssetReturns(series.map(item => ({
    id: item.asset.id,
    prices: item.prices.map(price => ({ date: price.date, value: price.adjustedClose && price.adjustedClose > 0 ? price.adjustedClose : price.close })),
  }))), [series]);
  const seriesWeights = series.map(item => {
    const assetIndex = assets.findIndex(asset => asset.id === item.asset.id);
    return assetIndex >= 0 ? weights[assetIndex] : 0;
  });
  const portfolioStats = useMemo(
    () => returnRows.length ? calculatePortfolioStats(returnRows, seriesWeights, 0.02, rebalancing) : null,
    [returnRows, series, assets, rebalancing, weights.join('|')],
  );
  const dailyReturns = portfolioStats?.daily ?? [];
  const riskSample = varPeriod === 'daily'
    ? dailyReturns
    : rollingPortfolioReturns(returnRows.map(row => row.date), dailyReturns, varPeriod === 'monthly' ? 30 : 365);
  const rollingSummary = useMemo(() => {
    const dates = returnRows.map(row => row.date);
    return [
      { label: '1 year', days: 365 },
      { label: '3 years', days: 1095 },
      { label: '5 years', days: 1825 },
    ].map(window => {
      const values = rollingPortfolioReturns(dates, dailyReturns, window.days).filter(Number.isFinite);
      const sorted = [...values].sort((a, b) => a - b);
      const median = sorted.length
        ? sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
        : null;
      return {
        label: window.label,
        observations: values.length,
        worst: values.length ? sorted[0] : null,
        median,
        best: values.length ? sorted[sorted.length - 1] : null,
      };
    });
  }, [returnRows, dailyReturns]);
  const tailRisk = calculateHistoricalTailRisk(riskSample, Number(varLevel) / 100);
  const varLoss = tailRisk.varLoss;
  const cvarLoss = tailRisk.cvarLoss;
  const corrMatrix = useMemo(() => correlationMatrix(returnRows), [returnRows]);
  const benchmarkIndex = series.findIndex(item => item.asset.id === benchmarkId);
  const benchmarkMetrics = useMemo(() => {
    if (!portfolioStats || benchmarkIndex < 0) return null;
    return calculateBenchmarkMetrics(
      dailyReturns,
      returnRows.map(row => row.returns[benchmarkIndex]),
      portfolioStats.periodsPerYear,
      0.02,
    );
  }, [dailyReturns, returnRows, portfolioStats, benchmarkIndex]);
  useEffect(() => { try { localStorage.setItem('wealth-os-lab-assets', JSON.stringify(assets)); } catch { /* local save is optional */ } }, [assets]);
  const selectedAssetKey = validAssets.map(asset => [asset.id, asset.ticker, asset.symbol].join('|')).join('||');
  useEffect(() => {
    setSeries([]);
    setOptimization([]);
    setMinimumVariance(null);
    setDataStatus('Portfolio assets changed. Reload market data to refresh the historical analysis.');
  }, [selectedAssetKey]);

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
      const rawFetched = await Promise.all(validAssets.map(async asset => {
        const symbol = asset.symbol.trim() || SYMBOLS[asset.ticker.toUpperCase()] || asset.ticker.toUpperCase();
        const response = await fetch(`${API}/api/saved-prices?symbol=${encodeURIComponent(symbol)}`, { headers: { Accept: 'application/json' } });
        const payload = await response.json();
        if (!response.ok) throw new Error(`${asset.ticker}: ${payload?.detail || response.statusText}`);
        const prices = Array.isArray(payload.prices)
          ? payload.prices.filter((price: Price) => price && typeof price.date === 'string' && Number.isFinite(price.close) && price.close > 0).sort((a: Price, b: Price) => a.date.localeCompare(b.date))
          : [];
        if (prices.length < 2) throw new Error(`${asset.ticker}: fewer than two valid saved prices were found for ${symbol}.`);
        const currencies = [...new Set(prices.map((price: Price) => price.currency).filter(Boolean))] as string[];
        const currency = (currencies[0] || '').toUpperCase();
        if (!currency || currencies.some(code => code.toUpperCase() !== currency)) {
          throw new Error(`${asset.ticker}: quote currency is missing or inconsistent in saved market data.`);
        }
        return { asset: { ...asset, symbol }, currency, prices };
      }));
      const foreignCurrencies = [...new Set(rawFetched.map(item => item.currency).filter(currency => currency !== 'EUR'))];
      const fxMap = new Map<string, FxPoint[]>();
      for (const currency of foreignCurrencies) fxMap.set(currency, await loadFxHistory(currency));
      const valuationDates = [...new Set([
        ...rawFetched.flatMap(item => item.prices.map((price: Price) => price.date)),
        ...[...fxMap.values()].flatMap(points => points.map(point => point.date)),
      ])].sort();
      const convertedByAsset = rawFetched.map(() => [] as Price[]);
      for (const date of valuationDates) {
        const eurValues = rawFetched.map(item => {
          const localPrice = latestPriceAt(item.prices, date);
          const fx = item.currency === 'EUR' ? 1 : latestFxRate(fxMap.get(item.currency) || [], date);
          return localPrice !== null && fx && fx > 0 ? localPrice / fx : null;
        });
        if (eurValues.every((value): value is number => value !== null && Number.isFinite(value) && value > 0)) {
          eurValues.forEach((value, index) => convertedByAsset[index].push({ date, close: value, adjustedClose: value, currency: 'EUR' }));
        }
      }
      const fetched: Series[] = rawFetched.map((item, index) => {
        const converted = convertedByAsset[index];
        if (converted.length < 30) throw new Error(`${item.asset.ticker}: fewer than 30 aligned EUR valuation dates are available. Check the saved prices and historical FX archive.`);
        return { asset: item.asset, prices: converted };
      });
      setSeries(fetched);
      const count = fetched.reduce((sum, item) => sum + item.prices.length, 0);
      setDataStatus(`${count.toLocaleString('en-GB')} aligned daily EUR valuation observations loaded; foreign-currency assets are revalued using the FX rate on each portfolio valuation date.`);
      setOptimization([]);
      setMinimumVariance(null);
      if (!count) setDataError('No saved prices were found for this allocation. Import market data first.');
    } catch (cause) {
      setSeries([]);
      setDataError(cause instanceof Error ? cause.message : String(cause));
      setDataStatus('Market data could not be loaded or converted reliably.');
    } finally { setLoading(false); }
  }
  function runOptimization() {
    if (returnRows.length < 30 || series.length < 2 || returnRows.some(row => row.returns.length !== series.length)) {
      setDataError('Load at least 30 aligned daily observations for two or more assets before optimization.');
      return;
    }
    const candidates = Array.from({ length: 5000 }, () => {
      const raw = series.map(() => -Math.log(Math.max(Math.random(), 1e-12)));
      const sum = raw.reduce((total, value) => total + value, 0);
      const candidateWeights = raw.map(value => value / sum);
      const stats = calculatePortfolioStats(returnRows, candidateWeights, 0.02, rebalancing);
      return { weights: candidateWeights, ret: stats.annualReturn || 0, vol: stats.vol || 0, sharpe: stats.sharpe || 0 };
    });
    const lowestRisk = [...candidates].sort((a, b) => a.vol - b.vol)[0] || null;
    setMinimumVariance(lowestRisk);
    setOptimization(candidates.sort((a, b) => b.sharpe - a.sharpe).slice(0, 20));
    setDataError('');
  }
  const stressByClass: Record<string, Record<string, number>> = {
    '2008': { Equity: -.38, Bond: -.05, Crypto: -.70, Commodity: -.25, 'Real Estate': -.40, Cash: 0, Other: -.25 },
    '2020': { Equity: -.34, Bond: .02, Crypto: -.50, Commodity: -.12, 'Real Estate': -.30, Cash: 0, Other: -.20 },
    '2022': { Equity: -.19, Bond: -.15, Crypto: -.65, Commodity: .05, 'Real Estate': -.25, Cash: 0, Other: -.20 },
    custom: { Equity: -.15, Bond: -.10, Crypto: -.35, Commodity: -.05, 'Real Estate': -.15, Cash: 0, Other: -.10 },
  };
  const stressImpact = assets.reduce((sum, asset, i) => sum + weights[i] * (stressByClass[stress]?.[asset.category] ?? stressByClass[stress]?.Other ?? 0), 0);
  const historicalIndex = portfolioStats?.nav ?? [];
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
        {page === 'Portfolio Analysis' && <><div className="page-heading"><div><div className="eyebrow">HISTORICAL PERFORMANCE</div><h1>Portfolio Analysis</h1><p>Historical performance from adjusted prices, aligned valuation dates and EUR-converted returns.</p></div><button className="button button-primary" onClick={loadMarketData} disabled={loading}>{loading?'Loading…':'↻ Load market data'}</button></div>
          {dataError&&<div className="alert">{dataError}</div>}<div className="data-status">{dataStatus}</div>
          <div className="metric-grid"><Metric label="Annualized return" value={pct(portfolioStats?.annualReturn??null)}/><Metric label="Annualized volatility" value={pct(portfolioStats?.vol??null)}/><Metric label="Sharpe ratio" value={portfolioStats?.sharpe?.toFixed(2)??'—'} hint="Risk-free rate: 2%"/><Metric label="Maximum drawdown" value={pct(portfolioStats?.maxDD??null)}/></div>
          <section className="panel"><div className="section-heading"><div><h2>Benchmark-relative performance</h2><p>CAPM alpha and beta, R-squared, tracking error and information ratio from aligned daily EUR returns.</p></div></div><div className="risk-controls"><label>Benchmark asset<select value={benchmarkIndex >= 0 ? benchmarkId : (series[0]?.asset.id || '')} onChange={event=>setBenchmarkId(event.target.value)}>{series.map(item=><option key={item.asset.id} value={item.asset.id}>{item.asset.name} ({item.asset.ticker})</option>)}</select></label></div><div className="metric-grid"><Metric label="Beta" value={benchmarkMetrics?.beta===null||benchmarkMetrics?.beta===undefined?'—':benchmarkMetrics.beta.toFixed(2)}/><Metric label="Jensen's alpha" value={pct(benchmarkMetrics?.alpha??null)} hint="Annualized arithmetic alpha"/><Metric label="R-squared" value={benchmarkMetrics?.rSquared===null||benchmarkMetrics?.rSquared===undefined?'—':benchmarkMetrics.rSquared.toFixed(3)}/><Metric label="Tracking error" value={pct(benchmarkMetrics?.trackingError??null)} hint="Annualized active-return volatility"/><Metric label="Information ratio" value={benchmarkMetrics?.informationRatio===null||benchmarkMetrics?.informationRatio===undefined?'—':benchmarkMetrics.informationRatio.toFixed(2)}/></div><p className="method-note">The selected benchmark is one of the loaded assets, not an external market index. Alpha is calculated as annualized mean portfolio excess return less beta times benchmark excess return, using a 2% annual risk-free rate. Results require overlapping observations and a benchmark with non-zero variance.</p></section>
          <section className="panel"><div className="section-heading"><div><h2>Growth of 100</h2><p>Portfolio NAV index, normalized to 100 at inception and adjusted for the selected rebalancing policy.</p></div></div><div className="risk-controls"><label>Rebalancing policy<select value={rebalancing} onChange={e=>setRebalancing(e.target.value as 'monthly'|'annual'|'none')}><option value="annual">Annual</option><option value="monthly">Monthly</option><option value="none">Buy and hold</option></select></label></div><LineChart values={historicalIndex}/><p className="method-note">Portfolio weights drift with relative asset returns between rebalancing dates. Daily valuation dates are aligned across assets; prices are converted to EUR using historical FX rates.</p></section>
          <section className="panel"><div className="section-heading"><div><h2>Rolling return analysis</h2><p>Compounded historical portfolio returns over overlapping calendar windows. These are total period returns, not annualized rates.</p></div></div><div className="table-scroll"><table className="data-table"><thead><tr><th>Rolling window</th><th>Observations</th><th>Worst period</th><th>Median period</th><th>Best period</th></tr></thead><tbody>{rollingSummary.map(row=><tr key={row.label}><td>{row.label}</td><td>{row.observations.toLocaleString('en-GB')}</td><td>{pct(row.worst)}</td><td>{pct(row.median)}</td><td>{pct(row.best)}</td></tr>)}</tbody></table></div><p className="method-note">Each observation compounds the aligned portfolio return series over the stated calendar window. Windows overlap and are not independent. A window is shown only when the available history spans its full duration.</p></section>
          <section className="panel"><div className="section-heading"><div><h2>Asset performance</h2><p>Adjusted prices converted to EUR; asset returns are shown over each asset's own available history.</p></div></div><div className="table-scroll"><table className="data-table"><thead><tr><th>Asset</th><th>Observations</th><th>First date</th><th>Last date</th><th>Period return</th><th>Weight</th></tr></thead><tbody>{series.map(s=><tr key={s.asset.id}><td>{s.asset.name} <small>({s.asset.ticker})</small></td><td>{s.prices.length.toLocaleString('en-GB')}</td><td>{s.prices[0]?.date||'—'}</td><td>{s.prices[s.prices.length-1]?.date||'—'}</td><td>{s.prices.length>1?pct((s.prices[s.prices.length-1].adjustedClose||s.prices[s.prices.length-1].close)/(s.prices[0].adjustedClose||s.prices[0].close)-1):'—'}</td><td>{pct(weights[assets.findIndex(a=>a.id===s.asset.id)])}</td></tr>)}</tbody></table></div></section>
        </>}
        {page === 'Monte Carlo' && <><div className="page-heading"><div><div className="eyebrow">FORWARD-LOOKING SIMULATION</div><h1>Monte Carlo</h1><p>Simulate a distribution of possible future portfolio outcomes.</p></div></div><MonteCarloSimulator key={assets.map(a=>[a.id,a.ticker,a.symbol,a.weight,a.expectedReturn,a.volatility].join(':')).join('|')+'|'+initialValue+'|'+contribution+'|'+horizon} initialPortfolioValue={Number(initialValue)||0} horizonYears={Number(horizon)||20} monthlyContribution={Number(contribution)||0} portfolioAssets={assets.map(a=>({name:a.name,ticker:a.ticker,symbol:a.symbol,category:a.category,value:a.weight,expectedReturn:a.expectedReturn,volatility:a.volatility}))}/></>}
        {page === 'Risk Analysis' && <><div className="page-heading"><div><div className="eyebrow">DOWNSIDE & RISK METRICS</div><h1>Risk Analysis</h1><p>Historical loss distribution and portfolio risk diagnostics.</p></div><button className="button button-primary" onClick={loadMarketData} disabled={loading}>{loading?'Loading…':'↻ Load market data'}</button></div>{dataError&&<div className="alert">{dataError}</div>}<div className="metric-grid"><Metric label="Volatility" value={pct(portfolioStats?.vol??null)}/><Metric label="Sharpe ratio" value={portfolioStats?.sharpe?.toFixed(2)??'—'}/><Metric label="Sortino ratio" value={portfolioStats?.sortino?.toFixed(2)??'—'}/><Metric label="Maximum drawdown" value={pct(portfolioStats?.maxDD??null)}/></div>
          <section className="panel"><div className="section-heading"><div><h2>Value at Risk & Expected Shortfall</h2><p>Historical simulation method; losses shown as positive percentages.</p></div></div><div className="risk-controls"><label>Confidence level<select value={varLevel} onChange={e=>setVarLevel(e.target.value as '95'|'99')}><option value="95">95%</option><option value="99">99%</option></select></label><label>Holding period<select value={varPeriod} onChange={e=>setVarPeriod(e.target.value as 'daily'|'monthly'|'annual')}><option value="daily">Daily</option><option value="monthly">Monthly (30 calendar days)</option><option value="annual">Annual (365 calendar days)</option></select></label></div><div className="metric-grid two"><Metric label={`Historical VaR ${varLevel}`} value={pct(varLoss)}/><Metric label={`Historical CVaR ${varLevel}`} value={pct(cvarLoss)} hint="Average loss beyond VaR threshold"/></div><p className="method-note">Daily VaR uses one-period returns. Monthly and annual VaR/CVaR are calculated directly from overlapping 30-day and 365-day compounded historical returns, not by square-root-of-time scaling. Available rolling observations: {tailRisk.observations.toLocaleString('en-GB')}.</p></section>
          <section className="panel"><div className="section-heading"><div><h2>Correlation matrix</h2><p>Daily return correlations across selected assets.</p></div></div><div className="table-scroll"><table className="data-table matrix"><thead><tr><th>Asset</th>{series.map(s=><th key={s.asset.id}>{s.asset.ticker}</th>)}</tr></thead><tbody>{series.map((s,i)=><tr key={s.asset.id}><th>{s.asset.ticker}</th>{series.map((t,j)=><td key={t.asset.id} style={{background:`rgba(91,126,220,${Math.abs(corrMatrix[i]?.[j]||0)*.24})`}}>{corrMatrix[i]?.[j]?.toFixed(2)??'—'}</td>)}</tr>)}</tbody></table></div></section>
          <section className="panel"><div className="section-heading"><div><h2>Illustrative stress scenarios</h2><p>Illustrative shocks applied to asset classes. These are not exact historical replays or statistically estimated stress distributions.</p></div></div><label className="stress-select">Scenario<select value={stress} onChange={e=>setStress(e.target.value)}><option value="2008">Global Financial Crisis (2008)</option><option value="2020">COVID-19 shock (2020)</option><option value="2022">Rate & inflation shock (2022)</option><option value="custom">Custom severe drawdown</option></select></label><div className="stress-result"><span>Estimated portfolio shock</span><strong className={stressImpact<0?'negative':''}>{pct(stressImpact)}</strong><small>Illustrative proxy based on position weights and broad asset-class shocks.</small></div></section>
        </>}
        {page === 'Optimization' && <><div className="page-heading"><div><div className="eyebrow">MEAN-VARIANCE FRAMEWORK</div><h1>Portfolio Optimization</h1><p>Explore 5,000 sampled long-only allocations using date-aligned EUR historical returns.</p></div><button className="button button-primary" onClick={runOptimization}>Run 5,000 portfolios</button></div>{dataError&&<div className="alert">{dataError}</div>}<div className="panel"><div className="section-heading"><div><h2>Optimization results</h2><p>5,000 Dirichlet-sampled long-only allocations; sampled maximum-Sharpe and minimum-volatility candidates. 2% risk-free rate.</p></div></div>{optimization.length===0?<div className="empty-state">Load historical data in Portfolio Analysis, then run the optimizer. Load aligned historical data first. These are sampled candidates, not a mathematically solved efficient frontier.</div>:<><div className="metric-grid two"><Metric label="Maximum Sharpe candidate" value={optimization[0]?.sharpe.toFixed(2)||'—'} hint="Best sampled risk-adjusted allocation"/><Metric label="Minimum volatility candidate" value={minimumVariance?pct(minimumVariance.vol):'—'} hint="Lowest sampled annualized volatility"/></div><div className="table-scroll"><table className="data-table"><thead><tr><th>Rank</th><th>Expected annual return</th><th>Annual volatility</th><th>Sharpe</th>{series.map(s=><th key={s.asset.id}>{s.asset.ticker||s.asset.name}</th>)}</tr></thead><tbody>{optimization.map((o,i)=><tr key={i}><td>{i+1}</td><td>{pct(o.ret)}</td><td>{pct(o.vol)}</td><td>{o.sharpe.toFixed(2)}</td>{o.weights.map((w,j)=><td key={j}>{pct(w)}</td>)}</tr>)}</tbody></table></div></>}</div></>}
        {page === 'Market Data' && <><div className="page-heading"><div><div className="eyebrow">MARKET DATA INFRASTRUCTURE</div><h1>Market Data</h1><p>Import full historical price series and maintain the durable market archive.</p></div></div><MarketDataImport assets={assets.map(a=>({id:a.id,name:a.name,ticker:a.ticker,category:a.category}))}/><section className="panel market-help"><h2>Supported market symbols</h2><p>Use Yahoo Finance symbols in the Market Symbol column in Portfolio Builder. Examples: VWCE.DE, VGWL.DE, EQQQ.DE, BTC-USD, ETH-USD, LDGL.L. Data is retrieved from the existing Wealth OS market-data API and stored in the connected archive when configured.</p><button className="button button-secondary" onClick={()=>setPage('Portfolio Analysis')}>Back to portfolio analysis</button></section></>}
      </div>
      <footer className="app-footer">WEALTH OS · PORTFOLIO ANALYTICS & SIMULATION <span>Hypothetical analysis only · Not investment advice</span></footer>
    </main>
  </div>;
}
