
import { useEffect, useMemo, useState } from 'react';
import { getListingsForInstrument, getMarketPrices, saveInstrument, saveListing, saveMarketPrices } from './data/database';
import type { AssetType } from './data/models';
import {
  buildXirrCashFlows,
  calculateTwr,
  calculateXirr,
  type ExternalCashFlow,
  type PortfolioValuation,
} from './performance';

type Transaction = {
  id?: string;
  date: string;
  type: string;
  amount: number;
  quantity: number;
  price: number;
  fee: number;
  ticker: string;
};

type AnalyticsAsset = {
  id: string;
  name: string;
  ticker: string;
  category: string;
  quantity: number;
  currentPrice: number;
  openingValue: number;
};

const MARKET_DATA_API_URL = 'https://wealth-os-market-data.onrender.com';

const YAHOO_SYMBOLS: Record<string, string> = {
  VGWL: 'VGWL.DE',
  EQQQ: 'EQQQ.DE',
  BTC: 'BTC-USD',
  LDGL: 'LDGL.L',
};

function safeId(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '_');
}

function inferAssetType(category: string): AssetType {
  const normalized = category.toLowerCase();
  if (normalized.includes('crypto') || normalized.includes('bitcoin')) return 'crypto';
  if (normalized.includes('bond') || normalized.includes('fixed income')) return 'bond';
  if (normalized.includes('commodit') || normalized.includes('gold')) return 'commodity';
  if (normalized.includes('real estate') || normalized.includes('property')) return 'real_estate';
  if (normalized.includes('cash')) return 'cash';
  if (normalized.includes('private equity')) return 'private_equity';
  if (normalized.includes('fund')) return 'fund';
  if (normalized.includes('stock')) return 'stock';
  return 'etf';
}

function yahooSymbolFor(ticker: string): string | undefined {
  const normalized = ticker.trim().toUpperCase();
  if (!normalized || ['OTHER', 'EUR', 'CASH'].includes(normalized)) return undefined;
  return YAHOO_SYMBOLS[normalized] ?? normalized;
}

type PricePoint = { date: string; value: number };

type ChartPoint = { date: string; value: number };

type MarketHistoryRow = {
  ticker: string;
  name: string;
  symbol: string;
  currency: string;
  records: number;
  firstDate: string;
  lastDate: string;
  firstClose: number;
  lastClose: number;
  change: number | null;
  annualizedVolatility: number | null;
  maxDrawdown: number | null;
  historicalVar95: number | null;
  sharpeRatio: number | null;
  sortinoRatio: number | null;
};

type AnalyticsProps = {
  assets: AnalyticsAsset[];
  currentValue: number;
  openingValue: number;
  openingCash: number;
  openingDate: string;
  transactions: Transaction[];
};

function today(): string {
  const now = new Date();

  return new Date(
    now.getTime() - now.getTimezoneOffset() * 60000
  )
    .toISOString()
    .slice(0, 10);
}

function money(value: number): string {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 2,
  }).format(value);
}

function percentage(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return '—';
  }

  return `${value >= 0 ? '+' : ''}${(
    value * 100
  ).toFixed(2)}%`;
}

function formatMarketPrice(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency,
      maximumFractionDigits: 4,
    }).format(value);
  } catch {
    return new Intl.NumberFormat('en-GB', {
      maximumFractionDigits: 4,
    }).format(value) + ' ' + currency;
  }
}


async function fetchFxHistory(currency: string): Promise<PricePoint[]> {
  const symbol = `EUR${currency}=X`;
  const response = await fetch(
    new URL('/api/history?symbol=' + encodeURIComponent(symbol) + '&period=max', MARKET_DATA_API_URL).toString(),
    { headers: { Accept: 'application/json' } },
  );
  if (!response.ok) throw new Error(`Historical FX data unavailable for ${currency} (HTTP ${response.status}).`);
  const payload: unknown = await response.json();
  if (typeof payload !== 'object' || payload === null || !('prices' in payload) || !Array.isArray(payload.prices)) {
    throw new Error(`Unexpected historical FX response for ${currency}.`);
  }
  return (payload.prices as Array<{ date?: unknown; close?: unknown }>)
    .filter((point): point is { date: string; close: number } =>
      typeof point.date === 'string' && typeof point.close === 'number' && Number.isFinite(point.close) && point.close > 0,
    )
    .map((point) => ({ date: point.date, value: point.close }))
    .sort((left, right) => left.date.localeCompare(right.date));
}

function lastPriceOnOrBefore(points: PricePoint[], date: string): PricePoint | undefined {
  let result: PricePoint | undefined;
  for (const point of points) {
    if (point.date > date) break;
    result = point;
  }
  return result;
}

function externalFlowsFromTransactions(
  transactions: Transaction[],
  asOfDate: string
): ExternalCashFlow[] {
  return transactions
    .filter(
      (tx) =>
        (tx.type === 'Deposit' ||
          tx.type === 'Withdrawal') &&
        tx.date <= asOfDate &&
        Number.isFinite(tx.amount) &&
        tx.amount > 0
    )
    .map((tx) => ({
      date: tx.date,
      type:
        tx.type === 'Deposit'
          ? 'contribution'
          : 'withdrawal',
      amount: tx.amount,
      description: tx.type,
    }));
}


function PerformanceChart({ title, points }: { title: string; points: ChartPoint[] }) {
  const width = 900;
  const height = 300;
  const padding = { top: 18, right: 24, bottom: 38, left: 56 };
  const values = points.map((point) => point.value);
  const minValue = Math.min(0, ...values);
  const maxValue = Math.max(0, ...values);
  const spread = maxValue - minValue || 1;
  const x = (index: number) => padding.left + (index / Math.max(1, points.length - 1)) * (width - padding.left - padding.right);
  const y = (value: number) => padding.top + ((maxValue - value) / spread) * (height - padding.top - padding.bottom);
  const polyline = points.map((point, index) => `${x(index)},${y(point.value)}`).join(' ');
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => maxValue - spread * fraction);
  return (
    <section className="panel" style={{ padding: 20, marginBottom: 20 }}>
      <div className="panel-heading">
        <div>
          <h3>{title}</h3>
          <p>Indexed performance (start = 0%); based on stored daily adjusted closing prices</p>
        </div>
      </div>
      {points.length < 2 ? (
        <p style={{ color: 'var(--muted)' }}>Not enough historical prices to draw this chart.</p>
      ) : (
        <div style={{ width: '100%', overflowX: 'auto' }}>
          <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title} style={{ width: '100%', minWidth: 520, display: 'block' }}>
            {ticks.map((tick) => (
              <g key={tick}>
                <line x1={padding.left} x2={width - padding.right} y1={y(tick)} y2={y(tick)} stroke="var(--border, #394150)" strokeDasharray="4 5" />
                <text x={padding.left - 10} y={y(tick) + 4} textAnchor="end" fontSize="11" fill="var(--muted, #9ca3af)">{tick.toFixed(0)}%</text>
              </g>
            ))}
            <line x1={padding.left} x2={width - padding.right} y1={y(0)} y2={y(0)} stroke="var(--muted, #9ca3af)" strokeWidth="1" />
            <polyline points={polyline} fill="none" stroke="var(--accent, #7c9cff)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
            <text x={padding.left} y={height - 10} fontSize="11" fill="var(--muted, #9ca3af)">{points[0].date}</text>
            <text x={width - padding.right} y={height - 10} textAnchor="end" fontSize="11" fill="var(--muted, #9ca3af)">{points[points.length - 1].date}</text>
          </svg>
        </div>
      )}
      {points.length > 1 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginTop: 8 }}>
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>Period return: <strong>{percentage(points[points.length - 1].value / 100)}</strong></span>
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>Observations: {points.length.toLocaleString('en-GB')}</span>
        </div>
      )}
    </section>
  );
}

export default function Analytics({
  assets,
  currentValue,
  openingValue,
  openingCash,
  openingDate,
  transactions,
}: AnalyticsProps) {
  const asOfDate = today();
  const [marketHistory, setMarketHistory] = useState<MarketHistoryRow[]>([]);
  const [marketSeries, setMarketSeries] = useState<Record<string, PricePoint[]>>({});
  const [chartAsset, setChartAsset] = useState('PORTFOLIO');
  const [chartRange, setChartRange] = useState('MAX');
  const [marketHistoryLoading, setMarketHistoryLoading] = useState(false);
  const [marketHistoryError, setMarketHistoryError] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function loadMarketHistory() {
      setMarketHistoryLoading(true);
      setMarketHistoryError('');

      try {
        const rows: MarketHistoryRow[] = [];
        const series: Record<string, PricePoint[]> = {};
        const fxCache: Record<string, PricePoint[]> = {};
        const fxWarnings: string[] = [];

        for (const asset of assets) {
          const symbol = yahooSymbolFor(asset.ticker);
          if (!symbol) continue;

          const instrumentId = 'instrument_' + safeId(asset.ticker);
          const listingId = 'listing_yahoo_' + safeId(symbol);
          let listings = await getListingsForInstrument(instrumentId);
          let listing = listings.find(
            (item) => item.provider === 'yahoo-finance' && item.status === 'active'
          );
          let prices = listing ? await getMarketPrices(listing.id) : [];

          // Restore the durable PostgreSQL archive into this browser's IndexedDB
          // automatically, rather than requiring the user to click Pull Market Data.
          if (prices.length === 0) {
            const response = await fetch(
              new URL('/api/saved-prices?symbol=' + encodeURIComponent(symbol), MARKET_DATA_API_URL).toString(),
              { headers: { Accept: 'application/json' } }
            );

            if (response.ok) {
              const payload: unknown = await response.json();
              if (
                typeof payload === 'object' &&
                payload !== null &&
                'prices' in payload &&
                Array.isArray(payload.prices) &&
                payload.prices.length > 0
              ) {
                const saved = payload as {
                  prices: Array<{
                    date: string;
                    currency?: string;
                    open?: number | null;
                    high?: number | null;
                    low?: number | null;
                    close: number;
                    adjustedClose?: number | null;
                    volume?: number | null;
                  }>;
                };
                const valid = saved.prices.filter(
                  (price) => typeof price.date === 'string' && Number.isFinite(price.close) && price.close > 0
                );
                if (valid.length > 0) {
                  const currency = valid.find((price) => price.currency)?.currency || 'USD';
                  await saveInstrument({
                    id: instrumentId,
                    name: asset.name,
                    assetType: inferAssetType(asset.category),
                    baseCurrency: currency,
                    status: 'active',
                    notes: 'Restored automatically from the durable market-data archive.',
                  });
                  await saveListing({
                    id: listingId,
                    instrumentId,
                    provider: 'yahoo-finance',
                    symbol,
                    quoteCurrency: currency,
                    isPrimary: true,
                    status: 'active',
                    lastVerifiedAt: new Date().toISOString(),
                  });
                  await saveMarketPrices(valid.map((price) => ({
                    listingId,
                    date: price.date,
                    provider: 'yahoo-finance' as const,
                    currency,
                    close: price.close,
                    adjustedClose: price.adjustedClose ?? price.close,
                    open: price.open ?? undefined,
                    high: price.high ?? undefined,
                    low: price.low ?? undefined,
                    volume: price.volume ?? undefined,
                  })));
                  listings = await getListingsForInstrument(instrumentId);
                  listing = listings.find((item) => item.id === listingId);
                  prices = listing ? await getMarketPrices(listing.id) : [];
                }
              }
            }
          }

          if (!listing || prices.length === 0) continue;

          const orderedPrices = [...prices].sort((left, right) => left.date.localeCompare(right.date));
          const first = orderedPrices[0];
          const last = orderedPrices[orderedPrices.length - 1];
          const rawCurrency = String(last.currency || listing.quoteCurrency || 'USD');
          const upperCurrency = rawCurrency.toUpperCase();
          const isPenceQuote = rawCurrency === 'GBp' || upperCurrency === 'GBX' || upperCurrency === 'GBPENCE' || (asset.ticker.toUpperCase() === 'LDGL' && upperCurrency === 'GBP');
          const quoteCurrency = isPenceQuote ? 'GBP' : upperCurrency;
          let fxPoints: PricePoint[] = [];

          if (quoteCurrency !== 'EUR') {
            try {
              fxPoints = fxCache[quoteCurrency] ?? await fetchFxHistory(quoteCurrency);
              fxCache[quoteCurrency] = fxPoints;
            } catch (cause) {
              fxWarnings.push(cause instanceof Error ? cause.message : `Historical FX data unavailable for ${quoteCurrency}.`);
            }
          }

          const converted = orderedPrices.flatMap((price) => {
            const rawPrice = price.adjustedClose ?? price.close;
            if (!Number.isFinite(rawPrice) || rawPrice <= 0) return [];
            const quoteValue = isPenceQuote ? rawPrice / 100 : rawPrice;
            if (quoteCurrency === 'EUR') return [{ date: price.date, value: quoteValue }];
            const fx = lastPriceOnOrBefore(fxPoints, price.date);
            if (!fx || fx.value <= 0) return [];
            const ageDays = (new Date(`${price.date}T00:00:00Z`).getTime() - new Date(`${fx.date}T00:00:00Z`).getTime()) / 86400000;
            if (ageDays > 7) return [];
            return [{ date: price.date, value: quoteValue / fx.value }];
          });

          if (converted.length > 0) series[asset.ticker] = converted;

          const closes = orderedPrices
            .map((price) => price.adjustedClose ?? price.close)
            .filter((value) => Number.isFinite(value) && value > 0);
          const returns = closes.slice(1).map((value, index) => value / closes[index] - 1)
            .filter((value) => Number.isFinite(value));
          const meanReturn = returns.length
            ? returns.reduce((sum, value) => sum + value, 0) / returns.length
            : 0;
          const variance = returns.length > 1
            ? returns.reduce((sum, value) => sum + Math.pow(value - meanReturn, 2), 0) / (returns.length - 1)
            : 0;
          const downside = returns.filter((value) => value < 0);
          const downsideDeviation = downside.length
            ? Math.sqrt(downside.reduce((sum, value) => sum + value * value, 0) / returns.length)
            : 0;
          const sortedReturns = [...returns].sort((a, b) => a - b);
          const varIndex = Math.max(0, Math.ceil(sortedReturns.length * 0.05) - 1);
          let runningPeak = closes[0] ?? 0;
          let maxDrawdown = 0;
          for (const close of closes) {
            runningPeak = Math.max(runningPeak, close);
            if (runningPeak > 0) maxDrawdown = Math.min(maxDrawdown, close / runningPeak - 1);
          }

          rows.push({
            ticker: asset.ticker,
            name: asset.name,
            symbol: listing.symbol,
            currency: last.currency,
            records: orderedPrices.length,
            firstDate: first.date,
            lastDate: last.date,
            firstClose: first.adjustedClose ?? first.close,
            lastClose: last.adjustedClose ?? last.close,
            change:
              (first.adjustedClose ?? first.close) > 0
                ? ((last.adjustedClose ?? last.close) / (first.adjustedClose ?? first.close)) - 1
                : null,
            annualizedVolatility: returns.length > 1 ? Math.sqrt(variance) * Math.sqrt(252) : null,
            maxDrawdown: returns.length > 1 ? maxDrawdown : null,
            historicalVar95: sortedReturns.length > 1 ? Math.max(0, -sortedReturns[varIndex]) : null,
            sharpeRatio: variance > 0 && returns.length > 1 ? (meanReturn * 252 - 0.02) / (Math.sqrt(variance) * Math.sqrt(252)) : null,
            sortinoRatio: downsideDeviation > 0 && returns.length > 1 ? (meanReturn * 252 - 0.02) / (downsideDeviation * Math.sqrt(252)) : null,
          });
        }

        if (!cancelled) {
          setMarketHistory(rows.sort((a, b) => a.ticker.localeCompare(b.ticker)));
          setMarketSeries(series);
          setMarketHistoryError(fxWarnings.length ? [...new Set(fxWarnings)].join(' ') : '');
        }
      } catch (cause) {
        if (!cancelled) {
          setMarketHistoryError(
            cause instanceof Error ? cause.message : 'Saved market history could not be loaded.'
          );
        }
      } finally {
        if (!cancelled) setMarketHistoryLoading(false);
      }
    }

    void loadMarketHistory();
    return () => {
      cancelled = true;
    };
  }, [assets]);

  const validTransactions = useMemo(
    () =>
      transactions.filter(
        (tx) =>
          /^\d{4}-\d{2}-\d{2}$/.test(tx.date) &&
          tx.date <= asOfDate &&
          Number.isFinite(tx.amount) &&
          Number.isFinite(tx.fee)
      ),
    [transactions, asOfDate]
  );

  const startDate =
    /^\d{4}-\d{2}-\d{2}$/.test(openingDate) &&
    openingDate <= asOfDate
      ? openingDate
      : '';

  const externalFlows = useMemo(
    () =>
      externalFlowsFromTransactions(
        validTransactions,
        asOfDate
      ),
    [validTransactions, asOfDate]
  );

  const netExternalContributions =
    externalFlows.reduce(
      (total, flow) =>
        total +
        (flow.type === 'contribution'
          ? flow.amount
          : -flow.amount),
      0
    );

  const valueChangeLessFlows =
    currentValue -
    openingValue -
    netExternalContributions;

  const portfolioValuations = useMemo((): PortfolioValuation[] => {
    const allDates = Object.values(marketSeries).flatMap((points) => points.map((point) => point.date));
    if (allDates.length === 0) return [];

    const earliestMarketDate = [...allDates].sort()[0];
    const requestedStart = startDate || earliestMarketDate;
    const openingAssetsWithHistory = assets.filter(
      (asset) => asset.openingValue > 0 && (marketSeries[asset.ticker]?.length ?? 0) > 0,
    );
    const openingPriceDates = openingAssetsWithHistory
      .map((asset) => marketSeries[asset.ticker].find((point) => point.date >= requestedStart)?.date)
      .filter((date): date is string => Boolean(date));
    const baselineDate = openingPriceDates.length
      ? openingPriceDates.sort().at(-1)!
      : [...allDates].filter((date) => date >= requestedStart).sort()[0];
    if (!baselineDate) return [];

    const initialQuantities = new Map<string, number>();
    const staticOpeningValues = new Map<string, number>();

    for (const asset of assets) {
      const history = marketSeries[asset.ticker] ?? [];
      const basePrice = lastPriceOnOrBefore(history, baselineDate);
      if (asset.openingValue > 0 && basePrice && basePrice.value > 0) {
        initialQuantities.set(asset.ticker, asset.openingValue / basePrice.value);
      } else if (asset.openingValue > 0) {
        staticOpeningValues.set(asset.ticker, asset.openingValue);
      }
    }

    const dates = [...new Set(allDates.filter((date) => date >= baselineDate))].sort();
    const orderedTransactions = [...transactions]
      .filter((tx) => /^\\d{4}-\\d{2}-\\d{2}$/.test(tx.date) && tx.date <= asOfDate)
      .sort((left, right) => left.date.localeCompare(right.date) || (left.id ?? '').localeCompare(right.id ?? ''));

    return dates.flatMap((date) => {
      let cash = openingCash;
      const quantities = new Map(initialQuantities);
      const staticValues = new Map(staticOpeningValues);

      for (const tx of orderedTransactions) {
        if (tx.date > date) break;
        const ticker = tx.ticker.toUpperCase();
        const history = marketSeries[ticker];
        switch (tx.type) {
          case 'Buy':
            if (history?.length) quantities.set(ticker, (quantities.get(ticker) ?? 0) + Math.max(0, tx.quantity || 0));
            else staticValues.set(ticker, (staticValues.get(ticker) ?? 0) + Math.max(0, tx.amount));
            cash -= tx.amount + tx.fee;
            break;
          case 'Sell':
            if (history?.length) quantities.set(ticker, Math.max(0, (quantities.get(ticker) ?? 0) - Math.max(0, tx.quantity || 0)));
            else staticValues.set(ticker, Math.max(0, (staticValues.get(ticker) ?? 0) - Math.max(0, tx.amount)));
            cash += tx.amount - tx.fee;
            break;
          case 'Dividend':
          case 'Deposit':
            cash += tx.amount - tx.fee;
            break;
          case 'Withdrawal':
          case 'Fee':
            cash -= tx.amount + tx.fee;
            break;
        }
      }

      let assetsValue = 0;
      for (const asset of assets) {
        const ticker = asset.ticker.toUpperCase();
        const history = marketSeries[ticker] ?? [];
        if (history.length > 0) {
          const price = lastPriceOnOrBefore(history, date);
          const quantity = quantities.get(ticker) ?? 0;
          if (price && quantity > 0) assetsValue += quantity * price.value;
        } else {
          assetsValue += staticValues.get(ticker) ?? 0;
        }
      }

      const value = assetsValue + cash;
      return Number.isFinite(value) && value >= 0 ? [{ date, value }] : [];
    }).filter((point, index, points) => index === 0 || point.date !== points[index - 1].date);
  }, [assets, marketSeries, transactions, openingCash, startDate, asOfDate]);


  const xirr = useMemo(() => {
    if (
      !startDate ||
      startDate >= asOfDate ||
      openingValue <= 0 ||
      currentValue <= 0
    ) {
      return null;
    }

    const cashFlows = buildXirrCashFlows({
      startDate,
      openingValue,
      externalFlows,
      endDate: asOfDate,
      endingValue: currentValue,
    });

    return calculateXirr(cashFlows);
  }, [
    startDate,
    asOfDate,
    openingValue,
    currentValue,
    externalFlows,
    portfolioValuations,
  ]);

  const twr = useMemo(() => {
    if (
      !startDate ||
      startDate >= asOfDate ||
      !Number.isFinite(openingValue) ||
      openingValue < 0 ||
      !Number.isFinite(currentValue) ||
      currentValue < 0
    ) {
      return null;
    }

    const valuations = portfolioValuations.length > 1
      ? portfolioValuations
      : [
          { date: startDate, value: openingValue },
          { date: asOfDate, value: currentValue },
        ];

    return calculateTwr(valuations, externalFlows);
  }, [
    startDate,
    asOfDate,
    openingValue,
    currentValue,
    externalFlows,
  ]);


  const portfolioHistoryWarnings = useMemo(() => {
    const warnings: string[] = [];
    for (const asset of assets) {
      if (asset.openingValue > 0 && !(marketSeries[asset.ticker]?.length)) {
        warnings.push(`${asset.ticker}: opening value is held flat because no historical market prices are available.`);
      }
      const hasTrades = transactions.some((tx) => tx.ticker.toUpperCase() === asset.ticker.toUpperCase() && (tx.type === 'Buy' || tx.type === 'Sell'));
      if (hasTrades && !(marketSeries[asset.ticker]?.length)) {
        warnings.push(`${asset.ticker}: trade values are represented at transaction cost because market prices are unavailable.`);
      }
    }
    return [...new Set(warnings)];
  }, [assets, marketSeries, transactions]);

  const chartData = useMemo(() => {
    const rangeDays = chartRange === '1Y' ? 365 : chartRange === '3Y' ? 365 * 3 : Number.POSITIVE_INFINITY;
    const cutoff = Number.isFinite(rangeDays)
      ? new Date(new Date(asOfDate + 'T00:00:00Z').getTime() - rangeDays * 86400000).toISOString().slice(0, 10)
      : '';

    if (chartAsset === 'PORTFOLIO') {
      const filtered = portfolioValuations.filter((point) => !cutoff || point.date >= cutoff);
      if (filtered.length < 2) return [];
      let growth = 1;
      const points: ChartPoint[] = [{ date: filtered[0].date, value: 0 }];
      for (let index = 1; index < filtered.length; index += 1) {
        const previous = filtered[index - 1];
        const current = filtered[index];
        const externalFlow = transactions.reduce((sum, tx) => {
          if (tx.date > previous.date && tx.date <= current.date) {
            if (tx.type === 'Deposit') return sum + tx.amount;
            if (tx.type === 'Withdrawal') return sum - tx.amount;
          }
          return sum;
        }, 0);
        if (previous.value <= 0) continue;
        const dailyReturn = (current.value - externalFlow) / previous.value - 1;
        if (!Number.isFinite(dailyReturn) || dailyReturn <= -1) continue;
        growth *= 1 + dailyReturn;
        points.push({ date: current.date, value: (growth - 1) * 100 });
      }
      return points;
    }

    const points = (marketSeries[chartAsset] ?? []).filter((point) => !cutoff || point.date >= cutoff);
    if (points.length < 2 || points[0].value <= 0) return [];
    const base = points[0].value;
    return points.map((point) => ({ date: point.date, value: (point.value / base - 1) * 100 }));
  }, [marketSeries, chartAsset, chartRange, asOfDate, portfolioValuations, transactions]);

  const chartRisk = useMemo(() => {
    const returns = chartData.slice(1).map((point, index) => {
      const previous = chartData[index].value / 100 + 1;
      const current = point.value / 100 + 1;
      return previous > 0 ? current / previous - 1 : 0;
    }).filter(Number.isFinite);
    const mean = returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : 0;
    const variance = returns.length > 1 ? returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1) : 0;
    const sorted = [...returns].sort((a, b) => a - b);
    const varIndex = Math.max(0, Math.ceil(sorted.length * 0.05) - 1);
    const sd = Math.sqrt(variance);
    const downside = returns.filter((value) => value < 0);
    const downsideDeviation = returns.length ? Math.sqrt(downside.reduce((sum, value) => sum + value ** 2, 0) / returns.length) : 0;
    return {
      volatility: returns.length > 1 ? sd * Math.sqrt(252) : null,
      dailySd: returns.length > 1 ? sd : null,
      var95: sorted.length > 1 ? Math.max(0, -sorted[varIndex]) : null,
      sharpe: sd > 0 && returns.length > 1 ? (mean * 252 - 0.02) / (sd * Math.sqrt(252)) : null,
      sortino: downsideDeviation > 0 && returns.length > 1 ? (mean * 252 - 0.02) / (downsideDeviation * Math.sqrt(252)) : null,
    };
  }, [chartData]);

  const hasOpeningCapital = openingValue > 0;
  const hasExternalFlows = externalFlows.length > 0;

  return (
    <div>
      <section className="panel" style={{ padding: 20, marginBottom: 20 }}>
        <div className="panel-heading">
          <div>
            <h3>Historical Market Data</h3>
            <p>Saved daily price history imported from Yahoo Finance</p>
          </div>
        </div>

        {marketHistoryLoading && <p>Loading saved price history…</p>}
        {marketHistoryError && (
          <p role="alert" style={{ color: '#e77969' }}>{marketHistoryError}</p>
        )}
        {!marketHistoryLoading && marketHistory.length === 0 && !marketHistoryError && (
          <p style={{ color: 'var(--muted)', lineHeight: 1.8 }}>
            No saved price history was found for these portfolio assets yet.
            Open Market Data and select Pull Market Data to import it.
          </p>
        )}
        {marketHistory.length > 0 && (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Symbol</th>
                    <th>History from</th>
                    <th>Latest date</th>
                    <th>Daily records</th>
                    <th>First close</th>
                    <th>Latest close</th>
                    <th>Price change</th>
                    <th>Volatility (ann.)</th>
                    <th>Max drawdown</th>
                    <th>Historical VaR 95% (daily)</th>
                    <th>Sharpe</th>
                    <th>Sortino</th>
                  </tr>
                </thead>
                <tbody>
                  {marketHistory.map((row) => (
                    <tr key={row.ticker}>
                      <td>{row.name} ({row.ticker})</td>
                      <td>{row.symbol}</td>
                      <td>{row.firstDate}</td>
                      <td>{row.lastDate}</td>
                      <td>{row.records.toLocaleString('en-GB')}</td>
                      <td>{formatMarketPrice(row.firstClose, row.currency)}</td>
                      <td>{formatMarketPrice(row.lastClose, row.currency)}</td>
                      <td>{row.change === null ? '—' : (row.change >= 0 ? '+' : '') + (row.change * 100).toFixed(2) + '%'}</td>
                      <td>{row.annualizedVolatility === null ? '—' : (row.annualizedVolatility * 100).toFixed(2) + '%'}</td>
                      <td>{row.maxDrawdown === null ? '—' : (row.maxDrawdown * 100).toFixed(2) + '%'}</td>
                      <td>{row.historicalVar95 === null ? '—' : (row.historicalVar95 * 100).toFixed(2) + '%'}</td>
                      <td>{row.sharpeRatio === null ? '—' : row.sharpeRatio.toFixed(2)}</td>
                      <td>{row.sortinoRatio === null ? '—' : row.sortinoRatio.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.8, marginTop: 12 }}>
              Risk metrics are calculated per asset from stored daily adjusted closes, using 252 trading days and a 2% annual risk-free rate. Historical VaR is the 95th-percentile one-day loss estimate. These are asset-level historical estimates, not portfolio-level forecasts; they do not include FX conversion, taxes, fees or correlations.
            </p>
          </>
        )}
      </section>

      <section className="panel" style={{ padding: 20, marginBottom: 20 }}>
        <div className="panel-heading">
          <div>
            <h3>Performance Charts</h3>
            <p>Indexed price performance, rebased to 0% at the start of the selected period</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
          <label style={{ display: 'grid', gap: 6, color: 'var(--muted)', fontSize: 12 }}>
            Chart
            <select value={chartAsset} onChange={(event) => setChartAsset(event.target.value)} style={{ minWidth: 190 }}>
              <option value="PORTFOLIO">Portfolio (ledger-based history)</option>
              {assets.filter((asset) => marketSeries[asset.ticker]?.length).map((asset) => (
                <option key={asset.ticker} value={asset.ticker}>{asset.name} ({asset.ticker})</option>
              ))}
            </select>
          </label>
          <label style={{ display: 'grid', gap: 6, color: 'var(--muted)', fontSize: 12 }}>
            Period
            <select value={chartRange} onChange={(event) => setChartRange(event.target.value)} style={{ minWidth: 130 }}>
              <option value="1Y">1 year</option>
              <option value="3Y">3 years</option>
              <option value="MAX">Maximum history</option>
            </select>
          </label>
        </div>
        <PerformanceChart
          title={chartAsset === 'PORTFOLIO' ? 'Historical portfolio performance (cash-flow adjusted)' : `${assets.find((asset) => asset.ticker === chartAsset)?.name ?? chartAsset} performance in EUR`}
          points={chartData}
        />
        <p style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.8 }}>
          Methodology: individual assets are converted to EUR using historical FX rates where available. The portfolio chart reconstructs daily holdings from opening balances and dated buys/sells, includes cash, dividends, fees and external flows, and links daily returns after adjusting for deposits and withdrawals. Opening positions with price history are scaled from their opening EUR values to the first available historical prices. Assets without price history are held at opening value or transaction cost and are flagged below. Cash-flow timing is assumed at end of day; results are therefore a ledger-based daily estimate, not an audited valuation.
        </p>
      </section>

      <section className="metrics" style={{ marginBottom: 20 }}>
        <div className="metric-card">
          <span className="metric-label">{chartAsset === 'PORTFOLIO' ? 'PORTFOLIO PROXY SHARPE' : 'ASSET SHARPE RATIO'}</span>
          <strong className="metric-value">{chartRisk.sharpe === null ? '—' : chartRisk.sharpe.toFixed(2)}</strong>
          <span className="metric-note">Annualized, 2% risk-free rate</span>
        </div>
        <div className="metric-card">
          <span className="metric-label">ANNUALIZED SD</span>
          <strong className="metric-value">{chartRisk.volatility === null ? '—' : percentage(chartRisk.volatility)}</strong>
          <span className="metric-note">Standard deviation of daily returns × √252</span>
        </div>
        <div className="metric-card">
          <span className="metric-label">DAILY SD</span>
          <strong className="metric-value">{chartRisk.dailySd === null ? '—' : percentage(chartRisk.dailySd)}</strong>
          <span className="metric-note">Standard deviation of daily returns</span>
        </div>
        <div className="metric-card">
          <span className="metric-label">HISTORICAL VaR 95% (DAILY)</span>
          <strong className="metric-value">{chartRisk.var95 === null ? '—' : percentage(chartRisk.var95)}</strong>
          <span className="metric-note">Historical one-day loss threshold</span>
        </div>
        <div className="metric-card">
          <span className="metric-label">SORTINO RATIO</span>
          <strong className="metric-value">{chartRisk.sortino === null ? '—' : chartRisk.sortino.toFixed(2)}</strong>
          <span className="metric-note">Downside-risk-adjusted return</span>
        </div>
      </section>

      <section className="welcome-row">
        <div>
          <h2>Portfolio Performance</h2>
          <p>
            Calculated automatically from My Portfolio
            and Transactions.
          </p>
        </div>
      </section>

      <section className="metrics">
        <div className="metric-card">
          <span className="metric-label">
            CURRENT NET WORTH
          </span>
          <strong className="metric-value">
            {money(currentValue)}
          </strong>
          <span className="metric-note">
            Assets plus cash balance
          </span>
        </div>

        <div className="metric-card">
          <span className="metric-label">
            OPENING NET WORTH
          </span>
          <strong className="metric-value">
            {money(openingValue)}
          </strong>
          <span className="metric-note">
            Opening balances used for this calculation
          </span>
        </div>

        <div className="metric-card">
          <span className="metric-label">
            NET EXTERNAL FLOWS
          </span>
          <strong className="metric-value">
            {money(netExternalContributions)}
          </strong>
          <span className="metric-note">
            Deposits less withdrawals
          </span>
        </div>

        <div className="metric-card">
          <span className="metric-label">
            VALUE CHANGE LESS FLOWS
          </span>
          <strong className="metric-value">
            {money(valueChangeLessFlows)}
          </strong>
          <span className="metric-note">
            Not a tax or performance statement
          </span>
        </div>
      </section>

      <section className="content-grid">
        <div
          className="panel"
          style={{ padding: 20 }}
        >
          <div className="panel-heading">
            <div>
              <h3>Money-Weighted Return (XIRR)</h3>
              <p>
                Annualized return, accounting for
                external cash flows
              </p>
            </div>
          </div>

          <strong
            className="metric-value"
            style={{
              display: 'block',
              margin: '18px 0',
            }}
          >
            {xirr
              ? percentage(xirr.annualizedReturn)
              : '—'}
          </strong>

          <p
            style={{
              color: 'var(--muted)',
              fontSize: 12,
              lineHeight: 1.8,
            }}
          >
            {xirr
              ? xirr.message
              : 'Not enough reliable data to calculate XIRR. Check the performance start date, opening value and current value.'}
          </p>

          <p
            style={{
              color: 'var(--muted)',
              fontSize: 12,
              lineHeight: 1.8,
            }}
          >
            XIRR treats deposits as money invested
            and withdrawals as money returned. Buys,
            sells, dividends and fees are not external
            contributions.
          </p>
        </div>

        <div
          className="panel"
          style={{ padding: 20 }}
        >
          <div className="panel-heading">
            <div>
              <h3>Time-Weighted Return (TWR)</h3>
              <p>Daily valuation-linked return when history is available</p>
            </div>
          </div>

          <strong
            className="metric-value"
            style={{
              display: 'block',
              margin: '18px 0',
            }}
          >
            {twr
              ? percentage(twr.cumulativeReturn)
              : '—'}
          </strong>

          <p
            style={{
              color: 'var(--muted)',
              fontSize: 12,
              lineHeight: 1.8,
            }}
          >
            {twr
              ? twr.message
              : 'Not enough data to estimate performance for this period.'}
          </p>

          <p
            style={{
              color: 'var(--muted)',
              fontSize: 12,
              lineHeight: 1.8,
            }}
          >
            When historical prices are available, this calculation links daily reconstructed portfolio valuations and adjusts for dated external flows. For assets without market history, the reconstruction uses static opening values or transaction-cost estimates, so results may be incomplete.
          </p>
        </div>
      </section>

      <section
        className="panel"
        style={{
          marginTop: 20,
          padding: 20,
        }}
      >
        <div className="panel-heading">
          <div>
            <h3>Data Quality & Methodology</h3>
            <p>
              What the current ledger can and cannot
              establish
            </p>
          </div>
        </div>

        <div
          style={{
            fontSize: 12,
            lineHeight: 1.9,
            color: 'var(--muted)',
          }}
        >
          <p>
            <strong>Valuation date:</strong>{' '}
            {asOfDate}
          </p>

          <p>
            <strong>Performance start date:</strong>{' '}
            {startDate || 'Unavailable'}
          </p>

          <p>
            <strong>External cash flows:</strong>{' '}
            {externalFlows.length}
          </p>

          <p>
            <strong>Opening capital:</strong>{' '}
            {hasOpeningCapital
              ? 'Available'
              : 'Zero or unavailable'}
          </p>

          <p>
            <strong>Opening date rule:</strong>{' '}
            The performance period starts on the day
            before the earliest recorded transaction,
            when that date is available in the app.
          </p>

          <p>
            <strong>Opening balance limitation:</strong>{' '}
            The opening value is derived from the
            opening balances in My Portfolio and
            opening cash. Editing those balances can
            retrospectively change calculated
            performance.
          </p>

          <p>
            <strong>Historical valuation method:</strong>{' '}
            Daily valuations are reconstructed from saved market prices, opening values, transaction quantities and the cash ledger. Deposits and withdrawals are adjusted as external flows. Where price history is missing, opening values are held flat and trade values use transaction cost.
          </p>
          {portfolioHistoryWarnings.length > 0 && (
            <p>
              <strong>Data quality warnings:</strong>{' '}
              {portfolioHistoryWarnings.join(' ')}
            </p>
          )}

          {!hasExternalFlows && (
            <p>
              No deposits or withdrawals have been
              recorded. Internal trades do not count
              as external cash flows.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
