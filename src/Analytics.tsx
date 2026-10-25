
import { useEffect, useMemo, useState } from 'react';
import { getListingsForInstrument, getMarketPrices } from './data/database';
import {
  buildXirrCashFlows,
  calculateTwr,
  calculateXirr,
  type ExternalCashFlow,
  type PortfolioValuation,
} from './performance';

type Transaction = {
  date: string;
  type: string;
  amount: number;
  fee: number;
  ticker: string;
};

type AnalyticsAsset = {
  id: string;
  name: string;
  ticker: string;
  quantity: number;
  currentPrice: number;
  openingValue: number;
};

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
};

type AnalyticsProps = {
  assets: AnalyticsAsset[];
  currentValue: number;
  openingValue: number;
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

export default function Analytics({
  assets,
  currentValue,
  openingValue,
  openingDate,
  transactions,
}: AnalyticsProps) {
  const asOfDate = today();
  const [marketHistory, setMarketHistory] = useState<MarketHistoryRow[]>([]);
  const [marketHistoryLoading, setMarketHistoryLoading] = useState(false);
  const [marketHistoryError, setMarketHistoryError] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function loadMarketHistory() {
      setMarketHistoryLoading(true);
      setMarketHistoryError('');

      try {
        const rows: MarketHistoryRow[] = [];

        for (const asset of assets) {
          const normalizedTicker = asset.ticker.trim().toUpperCase();
          const safeTicker = normalizedTicker.replace(/[^A-Z0-9_-]/g, '_');
          const instrumentId = 'instrument_' + safeTicker;
          const listings = await getListingsForInstrument(instrumentId);
          const listing = listings.find(
            (item) => item.provider === 'yahoo-finance' && item.status === 'active'
          );

          if (!listing) continue;

          const prices = await getMarketPrices(listing.id);
          if (prices.length === 0) continue;

          const first = prices[0];
          const last = prices[prices.length - 1];

          rows.push({
            ticker: asset.ticker,
            name: asset.name,
            symbol: listing.symbol,
            currency: last.currency,
            records: prices.length,
            firstDate: first.date,
            lastDate: last.date,
            firstClose: first.adjustedClose ?? first.close,
            lastClose: last.adjustedClose ?? last.close,
            change:
              (first.adjustedClose ?? first.close) > 0
                ? ((last.adjustedClose ?? last.close) / (first.adjustedClose ?? first.close)) - 1
                : null,
          });
        }

        if (!cancelled) {
          setMarketHistory(rows.sort((a, b) => a.ticker.localeCompare(b.ticker)));
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

    const valuations: PortfolioValuation[] = [
      {
        date: startDate,
        value: openingValue,
      },
      {
        date: asOfDate,
        value: currentValue,
      },
    ];

    return calculateTwr(
      valuations,
      externalFlows
    );
  }, [
    startDate,
    asOfDate,
    openingValue,
    currentValue,
    externalFlows,
  ]);

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
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.8, marginTop: 12 }}>
              Price change compares the first and latest stored closing prices in the listing currency. It is not the portfolio return and does not account for trades, dividends, taxes, FX or changing holdings.
            </p>
          </>
        )}
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
              <p>Modified Dietz estimate</p>
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
            This is an estimate based on opening and
            current portfolio values and dated external
            flows. It is not an exact daily time-weighted
            return because historical portfolio
            valuations are not stored.
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
            <strong>Historical valuation limitation:</strong>{' '}
            Wealth OS does not yet store a daily
            history of portfolio valuations. Therefore,
            TWR is an estimate rather than an exact
            daily time-weighted return.
          </p>

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
