# Wealth OS

Wealth OS is a local-first React + TypeScript application. Portfolio records and imported historical prices are stored in the browser using IndexedDB.

## Historical market data with yfinance

The app retrieves daily historical prices through the Python API in `backend/`. The API uses `yfinance` to query Yahoo Finance; it is not an official Yahoo Finance API, and Yahoo may rate-limit or change access at any time.

### Deploy the API for free on Render

1. In Render, choose **New + → Blueprint** and select this GitHub repository. Render reads the root `render.yaml` and creates the `wealth-os-market-data` web service.
2. Wait for deployment and open the service URL followed by `/health`. The response should contain `"status":"ok"`.
3. Open Wealth OS → **Market Data Import** and paste the deployed service's base URL into **yfinance API base URL**. The URL is saved in that browser.
4. Select a ticker such as `VGWL.DE`, `EQQQ.DE`, or `LDGL.DE`, choose a history period and press **Fetch from yfinance**.

Render's free web services can sleep after inactivity, so the first request may take longer while the service wakes up. Free hosting availability and quotas are controlled by Render and may change.

### Run the API locally

From the repository root:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
uvicorn backend.main:app --reload --port 8000
```

On Windows, activate the environment with `.venv\\Scripts\\activate`. Then set the API URL in Wealth OS to `http://127.0.0.1:8000`.

### API endpoints

- `GET /` — service information
- `GET /health` — health check
- `GET /api/history?symbol=VGWL.DE&period=max` — daily OHLCV history

Supported periods: `1y`, `2y`, `5y`, `10y`, `max`.

### Important notes

- Prices are stored in the browser that performs the import. IndexedDB does not automatically sync between devices.
- Failed requests do not delete previously saved prices.
- Some tickers have limited history or may not be available through Yahoo Finance.
- Historical data is not guaranteed to be real-time, complete, or suitable for trading. Check Yahoo Finance's terms for your intended use.


## Durable market-data archive and mark-to-market

The browser database remains the fast local cache. Market Data now also posts imported daily bars to `POST /api/saved-prices` and the API exposes `GET /api/saved-prices?symbol=VGWL.DE`. PostgreSQL upserts are keyed by symbol, date and provider, so refreshing a date corrects that record without creating duplicates. The archive is independent of browser storage and can be read from another device.

**One deployment step is required before server-side durability is active:** configure a managed PostgreSQL database and set its connection string as the `DATABASE_URL` environment variable on the `wealth-os-market-data` Render service. The API health response reports `durableStorage: configured` only when this variable exists. Without it, browser imports still work locally, but the API reports that durable storage is not configured; do not treat IndexedDB as a permanent backup.

After setting `DATABASE_URL`, redeploy the Render service and open `/health`. Confirm that `durableStorage` is `configured`, then run **Pull Market Data**. Historical prices are retained in PostgreSQL and overlapping dates are updated idempotently.

### Mark-to-market methodology

Imported EUR-quoted prices update the asset's latest price. For legacy opening balances that have a saved opening-price baseline, market value is adjusted proportionally to the latest price; tracked units are valued as quantity × latest price. The first import establishes the opening-price baseline, so it preserves the legacy opening value on that first sync and subsequent price changes move the valuation. Assets quoted in non-EUR currencies are not yet converted into the portfolio base currency and are deliberately not marked to market by the current callback. Cross-currency FX conversion and exact daily portfolio valuation snapshots remain follow-up work before treating performance, volatility, drawdown, Sharpe/Sortino, VaR or beta as production-grade.
