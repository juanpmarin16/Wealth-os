
import { useState } from 'react';

type TestResult = {
  symbol: string;
  currency: string;
  tradingDays: number;
  latestDate: string;
  latestClose: number;
};

export default function MarketDataTest() {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('Not tested');
  const [result, setResult] = useState<TestResult | null>(null);
  const [errorMessage, setErrorMessage] = useState('');

  async function runTest() {
    setLoading(true);
    setStatus('Testing connection...');
    setResult(null);
    setErrorMessage('');

    try {
      const response = await fetch(
        '/api/yahoo/v8/finance/chart/VGWL.DE?range=1mo&interval=1d',
        {
          method: 'GET',
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        },
      );

      if (!response.ok) {
        throw new Error(`Market data request failed: HTTP ${response.status}.`);
      }

      const data: unknown = await response.json();

      if (
        typeof data !== 'object' ||
        data === null ||
        !('chart' in data)
      ) {
        throw new Error('Yahoo Finance returned an invalid response.');
      }

      const chart = data.chart;

      if (
        typeof chart !== 'object' ||
        chart === null ||
        !('result' in chart) ||
        !Array.isArray(chart.result) ||
        !chart.result[0]
      ) {
        const message =
          'error' in chart &&
          typeof chart.error === 'object' &&
          chart.error !== null &&
          'description' in chart.error &&
          typeof chart.error.description === 'string'
            ? chart.error.description
            : 'No market data was returned for VGWL.DE.';

        throw new Error(message);
      }

      const market = chart.result[0];

      if (
        typeof market !== 'object' ||
        market === null ||
        !('timestamp' in market) ||
        !Array.isArray(market.timestamp) ||
        !('indicators' in market) ||
        typeof market.indicators !== 'object' ||
        market.indicators === null ||
        !('quote' in market.indicators) ||
        !Array.isArray(market.indicators.quote)
      ) {
        throw new Error('The market data format was unexpected.');
      }

      const timestamps: unknown[] = market.timestamp;
      const quote = market.indicators.quote[0];

      if (
        !quote ||
        typeof quote !== 'object' ||
        !('close' in quote) ||
        !Array.isArray(quote.close)
      ) {
        throw new Error('No daily closing prices were found.');
      }

      const prices: unknown[] = quote.close;

      const validRows = timestamps
        .map((timestamp, index) => ({
          timestamp,
          price: prices[index],
        }))
        .filter(
          (row): row is { timestamp: number; price: number } =>
            typeof row.timestamp === 'number' &&
            typeof row.price === 'number' &&
            Number.isFinite(row.price),
        );

      if (validRows.length === 0) {
        throw new Error('No valid closing prices were found.');
      }

      const latest = validRows[validRows.length - 1];

      const meta =
        'meta' in market &&
        typeof market.meta === 'object' &&
        market.meta !== null
          ? market.meta
          : null;

      const currency =
        meta &&
        'currency' in meta &&
        typeof meta.currency === 'string'
          ? meta.currency
          : 'EUR';

      setResult({
        symbol: 'VGWL.DE',
        currency,
        tradingDays: validRows.length,
        latestDate: new Date(latest.timestamp * 1000)
          .toISOString()
          .slice(0, 10),
        latestClose: latest.price,
      });

      setStatus('Connection successful');
    } catch (error) {
      setStatus('Connection failed');
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'An unexpected error occurred.',
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <main
      style={{
        minHeight: '100vh',
        padding: 24,
        background: '#0b1120',
        color: '#e5e7eb',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div style={{ maxWidth: 720, margin: '40px auto' }}>
        <div style={{ color: '#8b9cff', fontWeight: 700 }}>
          WEALTH OS
        </div>

        <h1>Market Data Connection Test</h1>

        <p style={{ color: '#aab4c8', lineHeight: 1.7 }}>
          Test whether the development server can retrieve real daily
          closing prices from Yahoo Finance. This diagnostic does not
          modify your portfolio or save market data.
        </p>

        <button
          type="button"
          onClick={runTest}
          disabled={loading}
          style={{
            marginTop: 16,
            padding: '13px 18px',
            borderRadius: 9,
            border: 0,
            background: loading ? '#596174' : '#7c8cff',
            color: '#ffffff',
            fontWeight: 700,
            cursor: loading ? 'wait' : 'pointer',
          }}
        >
          {loading ? 'Testing...' : 'Test Yahoo Finance Connection'}
        </button>

        <section
          style={{
            marginTop: 24,
            padding: 20,
            border: '1px solid #293449',
            borderRadius: 12,
            background: '#111a2c',
          }}
        >
          <h2 style={{ marginTop: 0 }}>Status</h2>
          <p>{status}</p>

          {result && (
            <div style={{ lineHeight: 1.9 }}>
              <p>Symbol: {result.symbol}</p>
              <p>Currency: {result.currency}</p>
              <p>Valid closing prices: {result.tradingDays}</p>
              <p>Latest market date: {result.latestDate}</p>
              <p>
                Latest close:{' '}
                {new Intl.NumberFormat('en-GB', {
                  style: 'currency',
                  currency: /^[A-Z]{3}$/.test(result.currency)
                    ? result.currency
                    : 'EUR',
                }).format(result.latestClose)}
              </p>
            </div>
          )}

          {errorMessage && (
            <p
              role="alert"
              style={{
                color: '#ffaaa7',
                overflowWrap: 'anywhere',
                lineHeight: 1.7,
              }}
            >
              {errorMessage}
            </p>
          )}
        </section>

        <p
          style={{
            marginTop: 24,
            color: '#8f9bb0',
            fontSize: 13,
            lineHeight: 1.7,
          }}
        >
          Yahoo Finance is an unofficial data source. Rate limits,
          network restrictions or provider policies may prevent requests.
        </p>
      </div>
    </main>
  );
}
