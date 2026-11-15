import { useEffect, useMemo, useState } from 'react';
import { db } from './data/database';
import { runMonteCarlo, type HistoryRow, type PathSummary, type SimulationModel, type ReturnDistribution } from './monteCarloEngine';

type PortfolioAsset = { name: string; ticker: string; symbol?: string; category: string; value: number; expectedReturn?: number; volatility?: number };
type Props = { initialPortfolioValue: number; portfolioAssets: PortfolioAsset[]; monthlyContribution?: number; horizonYears?: number };

const API = 'https://wealth-os-market-data.onrender.com';
const euro = (n: number) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(Number.isFinite(n) ? n : 0);
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
function quantile(values: number[], p: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lo = Math.floor(index);
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (index - lo);
}
function monthNumber(value: string) {
  const [year, month] = value.split('-').map(Number);
  return year * 12 + month - 1;
}
type FxPoint = { date: string; value: number };
async function loadFxHistory(currency: string): Promise<FxPoint[]> {
  const symbol = `EUR${currency}=X`;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`${API}/api/saved-prices?symbol=${encodeURIComponent(symbol)}`, {
      headers: { Accept: 'application/json' }, signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !Array.isArray(payload?.prices) || !payload.prices.length) {
      throw new Error(`Saved FX history for EUR/${currency} is unavailable. Use Update Market Data to import it.`);
    }
    return payload.prices
      .filter((point: any) => typeof point.date === 'string' && Number.isFinite(point.close) && point.close > 0)
      .map((point: any) => ({ date: point.date, value: Number.isFinite(point.adjustedClose) && point.adjustedClose > 0 ? point.adjustedClose : point.close }))
      .sort((a: FxPoint, b: FxPoint) => a.date.localeCompare(b.date));
  } finally {
    window.clearTimeout(timeout);
  }
}
function latestFxRate(points: FxPoint[], date: string): number | null {
  let low = 0, high = points.length - 1, found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (points[mid].date <= date) { found = mid; low = mid + 1; } else high = mid - 1;
  }
  if (found < 0) return null;
  const ageDays = (new Date(date + 'T00:00:00Z').getTime() - new Date(points[found].date + 'T00:00:00Z').getTime()) / 86400000;
  return ageDays <= 5 ? points[found].value : null;
}
function Histogram({ values }: { values: number[] }) {
  const bins = 24, max = Math.max(...values, 1), min = Math.min(...values, 0), step = (max - min) / bins || 1;
  const counts = Array(bins).fill(0) as number[];
  values.forEach(v => counts[clamp(Math.floor((v - min) / step), 0, bins - 1)]++);
  const peak = Math.max(...counts, 1), width = 760, height = 220, pad = 28, gap = 3, barW = (width - 2 * pad) / bins;
  return <svg className="mc-chart" viewBox={'0 0 ' + width + ' ' + height} role="img" aria-label="Ending balance distribution">
    {[0, .5, 1].map(t => <line key={t} x1={pad} x2={width - pad} y1={height - pad - (height - 2 * pad) * t} y2={height - pad - (height - 2 * pad) * t} className="mc-gridline" />)}
    {counts.map((c, i) => <rect key={i} x={pad + i * barW + gap / 2} y={height - pad - (height - 2 * pad) * c / peak} width={Math.max(1, barW - gap)} height={(height - 2 * pad) * c / peak} rx="2" fill="#7185ed" opacity=".8" />)}
    <text x={pad} y={height - 7} className="mc-axis-label">{euro(min)}</text><text x={width - pad} y={height - 7} textAnchor="end" className="mc-axis-label">{euro(max)}</text>
  </svg>;
}
export default function MonteCarloSimulator({ initialPortfolioValue, portfolioAssets, monthlyContribution = 0, horizonYears = 30 }: Props) {
  const suggestedStart = Math.max(0, Math.round(initialPortfolioValue || 0));
  const [initialAmount, setInitialAmount] = useState(String(suggestedStart));
  const [cashflow, setCashflow] = useState(String(Math.max(0, monthlyContribution * 12)));
  const [flowType, setFlowType] = useState<'contribution' | 'withdrawal' | 'percentage' | 'life'>('contribution');
  const [frequency, setFrequency] = useState('12');
  const [years, setYears] = useState(String(Math.min(60, Math.max(1, Math.round(horizonYears)))));
  const [runs, setRuns] = useState('5000');
  const [inflationAdjusted, setInflationAdjusted] = useState(true);
  const [inflation, setInflation] = useState('2.5');
  const [inflationVol, setInflationVol] = useState('1.5');
  const [assets, setAssets] = useState<Array<{ name: string; ticker: string; symbol?: string; proxyTicker?: string; weight: number; mean: number; vol: number }>>(() => {
    const total = portfolioAssets.reduce((sum, asset) => sum + Math.max(0, asset.value), 0);
    return portfolioAssets.length
      ? portfolioAssets.map(asset => ({ name: asset.name, ticker: asset.ticker, symbol: asset.symbol, proxyTicker: '', weight: total > 0 ? Math.max(0, asset.value) / total * 100 : 100 / portfolioAssets.length, mean: asset.expectedReturn ?? 7, vol: asset.volatility ?? 15 }))
      : [{ name: 'Global Equities', ticker: 'Equity', weight: 60, mean: 7, vol: 16 }, { name: 'Bonds', ticker: 'Bond', weight: 40, mean: 3.5, vol: 7 }];
  });
  const [results, setResults] = useState<PathSummary[] | null>(null);
  const [lastSeed, setLastSeed] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [model, setModel] = useState<SimulationModel>('historical');
  const [distribution, setDistribution] = useState<ReturnDistribution>('student');
  const [df, setDf] = useState('5');
  const [sequenceStress, setSequenceStress] = useState('0');
  const [rebalancing, setRebalancing] = useState<'monthly' | 'annual' | 'none'>('annual');
  const [blockYears, setBlockYears] = useState('0.0833333333');
  const [withdrawalPct, setWithdrawalPct] = useState('4');
  const [currentAge, setCurrentAge] = useState('40');
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [historyStatus, setHistoryStatus] = useState('Loading saved market history…');
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);

  const assetHistoryKey = assets.map(asset => [asset.ticker, asset.symbol || '', asset.proxyTicker || '', asset.name].join('|')).join('||');
  useEffect(() => {
    let cancelled = false;
    async function loadHistory() {
      setIsLoadingHistory(true);
      try {
        const [instruments, listings, prices, savedFx] = await Promise.all([
          db.instruments.toArray(), db.listings.toArray(), db.marketPrices.toArray(), db.fxRates.toArray(),
        ]);
        const byInstrument = new Map(instruments.map(item => [item.id, item]));
        const normalize = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, '');
        const symbolMappings = (() => {
          try {
            const raw = localStorage.getItem('wealth-os-market-data-symbol-mappings');
            const parsed = raw ? JSON.parse(raw) : {};
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
          } catch { return {}; }
        })();
        const defaultSymbols: Record<string, string> = {
          VGWL: 'VGWL.DE', EQQQ: 'EQQQ.DE', BTC: 'BTC-USD', VWCE: 'VWCE.DE', VWRL: 'VWRL.DE', VUSA: 'VUSA.DE', CSPX: 'CSPX.AS',
        };
        const matched = await Promise.all(assets.map(async asset => {
          const symbolFromAsset = asset.symbol?.trim() || '';
          const listing = listings.find(item => symbolFromAsset && normalize(item.symbol) === normalize(symbolFromAsset))
            || listings.find(item => normalize(item.symbol) === normalize(asset.ticker))
            || listings.find(item => normalize(byInstrument.get(item.instrumentId)?.name || '') === normalize(asset.name));
          const symbol = listing?.symbol || symbolFromAsset
            || symbolMappings[asset.ticker.toUpperCase()] || defaultSymbols[asset.ticker.toUpperCase()] || asset.ticker;
          let rows = listing
            ? prices.filter(price => price.listingId === listing.id && price.close > 0)
                .sort((a, b) => a.date.localeCompare(b.date))
            : [];
          let remoteCurrency = '';
          // Reconcile the browser cache with PostgreSQL on every load. A non-empty
          // IndexedDB cache can still be incomplete or older than the durable archive.
          if (symbol) {
            const controller = new AbortController();
            const timeout = window.setTimeout(() => controller.abort(), 12000);
            try {
              const response = await fetch(`${API}/api/saved-prices?symbol=${encodeURIComponent(symbol)}`, {
                headers: { Accept: 'application/json' }, signal: controller.signal,
              });
              const payload = await response.json().catch(() => null);
              if (response.ok && Array.isArray(payload?.prices)) {
                const remoteRows = payload.prices
                  .filter((point: any) => typeof point.date === 'string' && Number.isFinite(point.close) && point.close > 0)
                  .map((point: any) => ({
                    date: point.date,
                    close: point.close,
                    adjustedClose: Number.isFinite(point.adjustedClose) && point.adjustedClose > 0 ? point.adjustedClose : point.close,
                  }));
                const byDate = new Map<string, any>();
                rows.forEach((point: any) => byDate.set(point.date, point));
                remoteRows.forEach((point: any) => byDate.set(point.date, point));
                rows = [...byDate.values()].sort((a: any, b: any) => a.date.localeCompare(b.date)) as typeof rows;
                remoteCurrency = String(payload.prices.find((point: any) => point.currency)?.currency || '').toUpperCase();
              } else if (!rows.length) {
                throw new Error(`PostgreSQL archive returned no saved prices for ${symbol}.`);
              }
            } finally {
              window.clearTimeout(timeout);
            }
          }
          const instrument = listing ? byInstrument.get(listing.instrumentId) : undefined;
          const currency = (remoteCurrency || listing?.quoteCurrency || instrument?.baseCurrency || '').toUpperCase();
          if (!symbol || !rows.length) {
            throw new Error(`No saved or archived market history was found for ${asset.ticker || asset.name} (${symbol || 'no market symbol'}). Open Market Data, check its symbol mapping, and pull the full price history.`);
          }
          if (!currency) throw new Error(`The quote currency for ${asset.ticker} is unknown. Historical returns cannot be converted reliably to EUR.`);
          const primaryMonths = new Set(rows.map((point: any) => point.date.slice(0, 7))).size;
          let proxyRows: any[] = [];
          let proxyCurrency = '';
          let proxySymbol = '';
          if (primaryMonths < 13) {
            if (!asset.proxyTicker?.trim()) throw new Error(`${asset.ticker} has only ${primaryMonths} months of price history. Historical Monte Carlo requires at least 12 monthly returns (13 month-end prices). Select a proxy ticker for this asset in the Proxy ticker field, or use Parameterized returns.`);
            const proxyTicker = asset.proxyTicker.trim().toUpperCase();
            const proxyListing = listings.find(item => normalize(item.symbol) === normalize(proxyTicker)) || listings.find(item => normalize(byInstrument.get(item.instrumentId)?.name || '') === normalize(proxyTicker));
            proxySymbol = proxyListing?.symbol || symbolMappings[proxyTicker] || defaultSymbols[proxyTicker] || proxyTicker;
            let proxyLocal = proxyListing ? prices.filter(price => price.listingId === proxyListing.id && price.close > 0) : [];
            const proxyController = new AbortController();
            const proxyTimeout = window.setTimeout(() => proxyController.abort(), 12000);
            try {
              const proxyResponse = await fetch(`${API}/api/saved-prices?symbol=${encodeURIComponent(proxySymbol)}`, { headers: { Accept: 'application/json' }, signal: proxyController.signal });
              const proxyPayload = await proxyResponse.json().catch(() => null);
              if (proxyResponse.ok && Array.isArray(proxyPayload?.prices)) {
                const merged = new Map<string, any>();
                proxyLocal.forEach((point: any) => merged.set(point.date, point));
                proxyPayload.prices.filter((point: any) => typeof point.date === 'string' && Number.isFinite(point.close) && point.close > 0).forEach((point: any) => merged.set(point.date, { date: point.date, close: point.close, adjustedClose: Number.isFinite(point.adjustedClose) && point.adjustedClose > 0 ? point.adjustedClose : point.close }));
                proxyRows = [...merged.values()].sort((a: any, b: any) => a.date.localeCompare(b.date));
                proxyCurrency = String(proxyPayload.prices.find((point: any) => point.currency)?.currency || proxyListing?.quoteCurrency || '').toUpperCase();
              }
            } finally { window.clearTimeout(proxyTimeout); }
            if (!proxyRows.length) throw new Error(`Proxy ${proxyTicker} (${proxySymbol}) has no saved market history. Import its full history using Update Market Data before running Monte Carlo.`);
            if (!proxyCurrency) throw new Error(`The quote currency for proxy ${proxyTicker} is unknown. Historical returns cannot be converted reliably to EUR.`);
            const proxyMonths = new Set(proxyRows.map(point => point.date.slice(0, 7))).size;
            if (proxyMonths < 13) throw new Error(`Proxy ${proxyTicker} has only ${proxyMonths} months of history. Choose a proxy with at least 13 month-end prices.`);
          }
          return { asset, listing, currency, rows, proxyRows, proxyCurrency, proxySymbol };
        }));
        // Yahoo reports London-listed prices in pence (GBX/GBp); normalize
        // their FX exposure to GBP and scale quoted price levels from pence to pounds.
        const fxCurrencyFor = (currency: string) => currency === 'GBX' || currency === 'GBP' ? 'GBP' : currency;
        const priceScaleFor = (currency: string) => currency === 'GBX' ? 0.01 : 1;
        const foreignCurrencies = [...new Set(matched.flatMap(item => [fxCurrencyFor(item.currency), ...(item.proxyRows.length ? [fxCurrencyFor(item.proxyCurrency)] : [])]).filter(currency => currency !== 'EUR'))];
        const fxMap = new Map<string, FxPoint[]>();
        for (const currency of foreignCurrencies) {
          const pair = savedFx.filter(rate => rate.baseCurrency === 'EUR' && rate.quoteCurrency === currency)
            .map(rate => ({ date: rate.date, value: rate.rate })).sort((a, b) => a.date.localeCompare(b.date));
          const inverse = savedFx.filter(rate => rate.baseCurrency === currency && rate.quoteCurrency === 'EUR')
            .map(rate => ({ date: rate.date, value: 1 / rate.rate })).sort((a, b) => a.date.localeCompare(b.date));
          const local = pair.length ? pair : inverse;
          let remote: FxPoint[] = [];
          try { remote = await loadFxHistory(currency); }
          catch (cause) { if (!local.length) throw cause; }
          const merged = new Map<string, number>();
          local.forEach(point => merged.set(point.date, point.value));
          remote.forEach(point => merged.set(point.date, point.value));
          fxMap.set(currency, [...merged.entries()].map(([date, value]) => ({ date, value })).sort((a, b) => a.date.localeCompare(b.date)));
        }
        const assetPriceMonths = matched.map(item => {
          const months = new Map<string, { date: string; value: number }>();
          for (const point of item.rows) {
            const month = point.date.slice(0, 7);
            const existing = months.get(month);
            if (!existing || point.date > existing.date) months.set(month, {
              date: point.date,
              value: point.adjustedClose && point.adjustedClose > 0 ? point.adjustedClose : point.close,
            });
          }
          return months;
        });
        const monthlyMaps = matched.map((item, index) => {
          const monthly = new Map<string, number>();
          const addSeries = (sourceRows: any[], currency: string, onlyBefore?: string) => {
            const sourceMonths = new Map<string, { date: string; value: number }>();
            for (const point of sourceRows) {
              const month = point.date.slice(0, 7);
              if (onlyBefore && month >= onlyBefore) continue;
              const existing = sourceMonths.get(month);
              if (!existing || point.date > existing.date) sourceMonths.set(month, { date: point.date, value: point.adjustedClose && point.adjustedClose > 0 ? point.adjustedClose : point.close });
            }
            for (const [month, point] of sourceMonths) {
              const fxCurrency = fxCurrencyFor(currency);
              const fx = fxCurrency === 'EUR' ? 1 : latestFxRate(fxMap.get(fxCurrency) || [], point.date);
              if (fx && fx > 0) monthly.set(month, point.value * priceScaleFor(currency) / fx);
            }
          };
          if (item.proxyRows.length) {
            const inceptionMonth = [...assetPriceMonths[index].keys()].sort()[0];
            addSeries(item.proxyRows, item.proxyCurrency, inceptionMonth);
          }
          addSeries(item.rows, item.currency);
          return monthly;
        });
        const periods = [...monthlyMaps[0].keys()].filter(period => monthlyMaps.every(map => map.has(period))).sort();
        const rows: HistoryRow[] = [];
        for (let i = 1; i < periods.length; i++) {
          if (monthNumber(periods[i]) - monthNumber(periods[i - 1]) !== 1) continue;
          const returns = monthlyMaps.map(map => {
            const previous = map.get(periods[i - 1]) || 0;
            const current = map.get(periods[i]) || 0;
            return previous > 0 && current > 0 ? current / previous - 1 : NaN;
          });
          if (returns.every(Number.isFinite)) rows.push({ date: periods[i], returns });
        }
        if (!cancelled) {
          setHistory(rows);
          const currencyText = foreignCurrencies.length ? ` FX-converted to EUR (${foreignCurrencies.join(', ')}); GBX prices scaled to GBP before conversion.` : ' All assets are already quoted in EUR.';
          const assetCoverage = matched.map((item, index) => {
            const months = [...assetPriceMonths[index].keys()].sort();
            return `${item.asset.ticker}: ${item.rows.length.toLocaleString('en-GB')} daily / ${months.length} price months (${months[0] || '—'} to ${months[months.length - 1] || '—'})${item.proxyRows.length ? `; proxy ${item.asset.proxyTicker} used before inception (${item.proxyRows.length} daily prices)` : ''}`;
          }).join(' · ');
          const fxCoverage = foreignCurrencies.map(currency => {
            const points = fxMap.get(currency) || [];
            const first = points[0]?.date || '—', last = points[points.length - 1]?.date || '—';
            const monthlyFx = new Set(points.map(point => point.date.slice(0, 7))).size;
            return `EUR/${currency}: ${points.length} daily FX quotes / ${monthlyFx} FX months (${first} to ${last})`;
          }).join(' · ');
          const commonPriceMonths = assetPriceMonths.length
            ? [...assetPriceMonths[0].keys()].filter(month => assetPriceMonths.every(map => map.has(month))).sort()
            : [];
          const eurMonths = monthlyMaps.length
            ? [...monthlyMaps[0].keys()].filter(month => monthlyMaps.every(map => map.has(month))).sort()
            : [];
          const overlapText = commonPriceMonths.length
            ? `Raw price overlap: ${commonPriceMonths.length} months (${commonPriceMonths[0]} to ${commonPriceMonths[commonPriceMonths.length - 1]}).`
            : 'Raw price overlap: none.';
          const fxText = fxCoverage ? ` FX coverage: ${fxCoverage}.` : '';
          const alignedText = `EUR-converted overlap: ${eurMonths.length} months.`;
          const returnStatus = rows.length >= 12
            ? `${rows.length} complete one-month returns are available for simulation.`
            : rows.length >= 10
              ? `Limited history: ${rows.length} complete one-month returns are available. Historical bootstrap is enabled, but this short sample increases estimation uncertainty. Use 1-month blocks; longer blocks are limited by available history.`
              : `Only ${rows.length} complete one-month returns are available; at least 10 are required for historical bootstrap. This requires at least 11 aligned month-end price points for every selected asset. Check the asset inception date and saved price history.`;
          setHistoryStatus(`${returnStatus} ${assetCoverage}. ${overlapText} ${alignedText}${fxText}${currencyText}`);
        }
      } catch (cause) {
        if (!cancelled) {
          setHistory([]);
          setHistoryStatus(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (!cancelled) setIsLoadingHistory(false);
      }
    }
    if (assets.length) loadHistory();
    else { setHistoryStatus('Add at least one asset to load historical data.'); setIsLoadingHistory(false); }
    return () => { cancelled = true; };
  }, [assetHistoryKey]);
  const totalWeight = assets.reduce((sum, a) => sum + a.weight, 0);
  const currentValue = Number(initialAmount) || 0;
  const valid = currentValue >= 0 && Number(cashflow) >= 0 && Number.isInteger(Number(years)) && Number(years) >= 1 && Number(years) <= 60 && Number.isInteger(Number(runs)) && Number(runs) >= 100 && Number(runs) <= 20000 && totalWeight > 0 && assets.every(asset => asset.weight >= 0 && asset.mean > -100 && asset.vol >= 0);
  const normalizedAssets = assets.map(a => ({ ...a, weight: a.weight / totalWeight }));
  const runSimulation = () => {
    if (!valid) return;
    setError('');
    const count = clamp(Math.round(Number(runs)), 100, 20000);
    const duration = clamp(Math.round(Number(years)), 1, 60);
    const seed = Math.floor(Math.random() * 0xffffffff);
    const simulationAssets = normalizedAssets.map(asset => ({ name: asset.name, ticker: asset.ticker, weight: asset.weight, mean: asset.mean, vol: asset.vol }));
    try {
      const nextResults = runMonteCarlo({
        years: duration,
        initialValue: currentValue,
        annualCashflow: Number(cashflow) || 0,
        frequency: Number(frequency),
        inflationAdjustedCashflows: inflationAdjusted,
        inflationMean: Number(inflation) || 0,
        inflationVolatility: Number(inflationVol) || 0,
        model,
        distribution,
        degreesOfFreedom: Number(df),
        cashflowType: flowType,
        annualWithdrawalRate: Number(withdrawalPct) || 0,
        currentAge: Number(currentAge) || 40,
        sequenceStressYears: Number(sequenceStress) || 0,
        blockYears: Number(blockYears) || 1,
        rebalancing,
        seed,
      }, simulationAssets, history, count);
      setResults(nextResults);
      setLastSeed(seed);
    } catch (cause) {
      setResults(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };


  const stats = useMemo(() => {
    if (!results?.length) return null;
    const nominal = results.map(result => result.ending);
    const real = results.map(result => result.realEnding);
    const drawdowns = results.map(result => result.maxDrawdown);
    const yearsCount = results[0].yearly.length - 1;
    const medianPath = Array.from({ length: yearsCount + 1 }, (_, year) => quantile(results.map(result => result.yearly[year]), .5));
    const p10Path = Array.from({ length: yearsCount + 1 }, (_, year) => quantile(results.map(result => result.yearly[year]), .1));
    const p90Path = Array.from({ length: yearsCount + 1 }, (_, year) => quantile(results.map(result => result.yearly[year]), .9));
    const annualized = results.map(result => result.annualizedReturn);
    const percentiles = [.05,.1,.25,.5,.75,.9,.95];
    const distributionRows = percentiles.map(p => [(p * 100) + 'th', euro(quantile(nominal, p)), euro(quantile(real, p)), pct(quantile(annualized, p))]);
    const survival = results.filter(result => flowType === 'contribution' ? result.ending > 0 : result.survived).length / results.length;
    const lossProbability = results.filter(result => result.ending < currentValue + result.totalContributions - result.totalWithdrawals).length / results.length;
    const riskRows = [
      ['Average total contributions', euro(results.reduce((sum, result) => sum + result.totalContributions, 0) / results.length)],
      ['Average total withdrawals', euro(results.reduce((sum, result) => sum + result.totalWithdrawals, 0) / results.length)],
      ['Average ending balance', euro(nominal.reduce((sum, value) => sum + value, 0) / nominal.length)],
      ['Probability of ending below net nominal capital contributed', pct(lossProbability)],
      [flowType === 'contribution' ? 'Probability of retaining a positive balance' : 'Probability of funding all scheduled withdrawals', pct(survival)],
      ['Median maximum drawdown (cashflow-adjusted NAV)', pct(quantile(drawdowns, .5))],
      ['95th percentile maximum drawdown (cashflow-adjusted NAV)', pct(quantile(drawdowns, .95))],
    ];
    const yearlyRows = Array.from({ length: yearsCount + 1 }, (_, year) => [String(year), ...[.1,.25,.5,.75,.9].map(p => euro(quantile(results.map(result => result.yearly[year]), p)))]);
    return { nominal, real, drawdowns, medianPath, p10Path, p90Path, survival, lossProbability, distributionRows, riskRows, yearlyRows };
  }, [results, currentValue, flowType]);


  const updateAsset = (index: number, field: 'name' | 'ticker' | 'proxyTicker' | 'weight' | 'mean' | 'vol', value: string) => {
    setAssets(prev => prev.map((a, i) => i === index ? { ...a, [field]: field === 'name' ? value : value.toUpperCase() : Number(value) || 0 } : a));
  };
  const addAsset = () => { if (assets.length < 12) setAssets(prev => [...prev, { name: `Asset ${prev.length + 1}`, ticker: '', proxyTicker: '', weight: 0, mean: 5, vol: 15 }]); };
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
    <header className="mc-heading"><div><p className="mc-eyebrow">PLANNING & RISK</p><h2>Monte Carlo Simulator</h2><p>Explore thousands of possible portfolio outcomes instead of relying on a single forecast. {portfolioAssets.length ? `Starting from ${assets.length} assets; add or remove assets below.` : 'No assets found; add a hypothetical allocation to begin.'}</p></div><span className="mc-pill">Stochastic projection</span></header>
    <div className="mc-layout">
      <section className="panel mc-config">
        <div className="mc-section-title"><div><h3>Simulation settings</h3><p>All amounts are in EUR. Assumptions are editable.</p></div></div>
        <div className="mc-fields">
          <label>Initial portfolio value<input type="number" min="0" step="100" value={initialAmount} onChange={e => setInitialAmount(e.target.value)} /></label>
          <label>Horizon (years)<input type="number" min="1" max="60" value={years} onChange={e => setYears(e.target.value)} /></label>
          {(flowType === 'contribution' || flowType === 'withdrawal') && <label>{flowType === 'contribution' ? 'Annual contribution amount' : 'Annual withdrawal amount'}<input type="number" min="0" step="100" value={cashflow} onChange={e => setCashflow(e.target.value)} /></label>}
          <label>Cashflow frequency<select value={frequency} onChange={e => setFrequency(e.target.value)}><option value="1">Annually</option><option value="2">Semi-annually</option><option value="4">Quarterly</option><option value="12">Monthly</option></select></label>
          <label>Cashflow type<select value={flowType} onChange={e => setFlowType(e.target.value as 'contribution' | 'withdrawal' | 'percentage' | 'life')}><option value="contribution">Contributions</option><option value="withdrawal">Withdrawals</option><option value="percentage">Fixed percentage withdrawals</option><option value="life">Life-expectancy withdrawals</option></select></label>
          <label>Simulation paths<input type="number" min="100" max="20000" step="100" value={runs} onChange={e => setRuns(e.target.value)} /></label>
          <label>Expected inflation mean (%)<input type="number" min="-5" max="20" step="0.1" value={inflation} onChange={e => setInflation(e.target.value)} /></label>
          <label>Inflation volatility (%)<input type="number" min="0" max="20" step="0.1" value={inflationVol} onChange={e => setInflationVol(e.target.value)} /></label>
          {model === 'historical' && <label>Bootstrap block length<select value={blockYears} onChange={e => setBlockYears(e.target.value)}><option value="0.0833333333">1 month (independent monthly blocks)</option><option value="0.25" disabled={history.length < 3}>3 months</option><option value="0.5" disabled={history.length < 6}>6 months</option><option value="1" disabled={history.length < 12}>1 year</option><option value="2" disabled={history.length < 24}>2 years</option><option value="3" disabled={history.length < 36}>3 years</option><option value="5" disabled={history.length < 60}>5 years</option></select></label>}
          <label>Simulation model<select value={model} onChange={e => setModel(e.target.value as SimulationModel)}><option value="historical">Historical bootstrap</option><option value="statistical">Statistical returns (historical moments)</option><option value="parameterized">Parameterized returns (manual assumptions)</option></select></label>
          {model !== 'historical' && <label>Return distribution<select value={distribution} onChange={e => setDistribution(e.target.value as ReturnDistribution)}><option value="normal">Normal</option><option value="student">Student t (fat tails)</option></select></label>}
          {model !== 'historical' && distribution === 'student' && <label>Student t degrees of freedom<input type="number" min="3" max="30" step="1" value={df} onChange={e => setDf(e.target.value)} /></label>}
          <label>Rebalancing<select value={rebalancing} onChange={e => setRebalancing(e.target.value as 'monthly' | 'annual' | 'none')}><option value="annual">Annual</option><option value="monthly">Monthly</option><option value="none">Buy and hold (no rebalancing)</option></select></label>
          <label>Worst return years first<select value={sequenceStress} onChange={e => setSequenceStress(e.target.value)}><option value="0">Off</option>{Array.from({ length: 10 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1} year(s)</option>)}</select></label>
          {flowType === 'percentage' && <label>Annual withdrawal (%)<input type="number" min="0" max="30" step="0.25" value={withdrawalPct} onChange={e => setWithdrawalPct(e.target.value)} /></label>}
          {flowType === 'life' && <label>Current age<input type="number" min="18" max="99" value={currentAge} onChange={e => setCurrentAge(e.target.value)} /></label>}
          <label className="mc-checkbox"><input type="checkbox" checked={inflationAdjusted} disabled={flowType === 'percentage' || flowType === 'life'} onChange={e => setInflationAdjusted(e.target.checked)} /><span>Inflation-adjust fixed cashflows</span></label>
        </div>
        <div className="mc-section-title mc-assets-title"><div><h3>Asset allocation & assumptions</h3><p>Weights are normalized automatically. Assets with less than 12 months of history require a proxy ticker. Proxy returns are used only before the selected instrument's inception; the instrument's own returns take over afterward. All series are converted to EUR.</p></div><button className="secondary-button" onClick={addAsset} disabled={assets.length >= 12}>+ Add asset</button></div>
        <div className="mc-table-wrap"><table className="mc-assets-table"><thead><tr><th>Asset</th><th>Ticker</th><th>Proxy ticker</th><th>Weight %</th><th>Annual expected return %</th><th>Annual volatility %</th><th></th></tr></thead><tbody>
          {assets.map((asset, i) => <tr key={i}><td><input aria-label={`Asset ${i + 1} name`} value={asset.name} onChange={e => updateAsset(i, 'name', e.target.value)} /></td><td><input aria-label={`Asset ${i + 1} ticker`} value={asset.ticker} onChange={e => updateAsset(i, 'ticker', e.target.value)} /></td><td><input aria-label={`Asset ${i + 1} proxy ticker`} placeholder="Required if <12 months" value={asset.proxyTicker || ''} onChange={e => updateAsset(i, 'proxyTicker', e.target.value)} /></td><td><input aria-label={`Asset ${i + 1} weight`} type="number" min="0" max="100" value={asset.weight} onChange={e => updateAsset(i, 'weight', e.target.value)} /></td><td><input aria-label={`Asset ${i + 1} mean return`} type="number" min="-99" max="200" step="0.1" value={asset.mean} disabled={model !== 'parameterized'} onChange={e => updateAsset(i, 'mean', e.target.value)} /></td><td><input aria-label={`Asset ${i + 1} volatility`} type="number" min="0" max="200" step="0.1" value={asset.vol} disabled={model !== 'parameterized'} onChange={e => updateAsset(i, 'vol', e.target.value)} /></td><td><button className="mc-remove" aria-label="Remove asset" onClick={() => setAssets(prev => prev.filter((_, j) => j !== i))} disabled={assets.length <= 1}>×</button></td></tr>)}
        </tbody></table></div>
        <div className="mc-allocation-foot"><span>Total entered allocation</span><strong className={Math.abs(totalWeight - 100) < 0.01 ? 'is-balanced' : ''}>{totalWeight.toFixed(1)}%</strong></div>
        <button className="primary-button mc-run-button" onClick={runSimulation} disabled={!valid || isLoadingHistory}><span>▶</span> Run {Number(runs).toLocaleString('en-GB')} simulations</button>
        {!valid && <p className="mc-validation">Enter a valid initial value, horizon, number of paths and positive total allocation.</p>}
        {error && <p className="mc-validation" role="alert">{error}</p>}
        <p className="mc-history-status">{isLoadingHistory ? 'Loading market history…' : historyStatus}</p><p className="mc-disclaimer">Historical bootstrap resamples complete consecutive monthly EUR returns. Statistical returns use historical moments and correlations; parameterized returns use your editable assumptions. FX conversion is required for non-EUR assets. Parameterized mode uses historical correlations when available; without a historical sample it assumes zero cross-asset correlations. Annual mean return and volatility are arithmetic annualized inputs. Results are hypothetical and exclude taxes and fees.</p>
      </section>
      <section className="mc-results">
        {!stats && <div className="panel mc-empty"><div className="mc-empty-icon">⌁</div><h3>Your projection starts here</h3><p>Set your assumptions and run the simulation to see a range of possible outcomes, portfolio survival and downside risk.</p><div className="mc-empty-stats"><span><strong>10th–90th</strong><small>Outcome range</small></span><span><strong>Median</strong><small>Central scenario</small></span><span><strong>5,000</strong><small>Paths by default</small></span></div></div>}
        {stats && <><div className="mc-result-header"><div><h3>Simulation results</h3><p>{results?.length.toLocaleString('en-GB')} paths · {years} years · seed {lastSeed} · nominal and inflation-adjusted values</p></div><button className="secondary-button" onClick={runSimulation}>↻ Re-run</button></div>
          <div className="mc-kpis">
            <div className="panel mc-kpi"><span>Median ending balance</span><strong>{euro(quantile(stats.nominal, .5))}</strong><small>Nominal value</small></div>
            <div className="panel mc-kpi"><span>10th percentile</span><strong>{euro(quantile(stats.nominal, .1))}</strong><small>Downside outcome</small></div>
            <div className="panel mc-kpi"><span>90th percentile</span><strong>{euro(quantile(stats.nominal, .9))}</strong><small>Upside outcome</small></div>
            <div className="panel mc-kpi"><span>{flowType === 'contribution' ? 'Ending above zero' : 'Withdrawal survival'}</span><strong>{pct(stats.survival)}</strong><small>{flowType === 'contribution' ? 'Paths retaining a positive balance' : 'Paths funding all withdrawals'}</small></div>
          </div>
          <div className="panel mc-chart-panel"><div className="mc-section-title"><div><h3>Portfolio balance over time</h3><p>10th–90th percentile range and median path</p></div></div>{chart(stats.p10Path, stats.medianPath, stats.p90Path)}<div className="mc-legend"><span><i className="mc-legend-low" />10th percentile</span><span><i className="mc-legend-median" />Median</span><span><i className="mc-legend-high" />90th percentile</span></div></div>
          <div className="panel mc-table-panel"><div className="mc-section-title"><div><h3>Portfolio value by year</h3><p>Percentile table of nominal year-end balances</p></div></div><table className="mc-summary-table"><thead><tr><th>Year</th><th>10th</th><th>25th</th><th>Median</th><th>75th</th><th>90th</th></tr></thead><tbody>{stats.yearlyRows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table></div>
          <div className="panel mc-chart-panel"><div className="mc-section-title"><div><h3>Ending portfolio distribution</h3><p>Frequency histogram of simulated terminal balances</p></div></div><Histogram values={stats.nominal}/></div>
          <div className="panel mc-table-panel"><div className="mc-section-title"><div><h3>Ending balance and return distribution</h3><p>Nominal and inflation-adjusted ending value plus annualized return</p></div></div><table className="mc-summary-table"><thead><tr><th>Percentile</th><th>Nominal ending</th><th>Real ending</th><th>Annualized return</th></tr></thead><tbody>{stats.distributionRows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table></div>
          <div className="panel mc-table-panel"><div className="mc-section-title"><div><h3>Cashflow and risk summary</h3><p>Capital survival, cashflows and drawdown outcomes</p></div></div><table className="mc-summary-table"><thead><tr><th>Metric</th><th>Result</th></tr></thead><tbody>{stats.riskRows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table></div>
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
