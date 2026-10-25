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
