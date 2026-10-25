# Neon PostgreSQL setup for Wealth OS

The market-data API is a Python/FastAPI service. The React/Vite frontend must never receive the PostgreSQL connection string. Keep `DATABASE_URL` on the API host only.

## 1. Create or select the Neon database

In the Neon console, select the existing Wealth OS project and the `production` branch. Copy the connection string for the application role. Prefer the pooled connection string when Neon offers one. Keep the password private.

## 2. Configure the Render API

The API is deployed from `render.yaml` as `wealth-os-market-data`.

1. Open the service in Render.
2. Open **Environment**.
3. Add `DATABASE_URL` with the Neon PostgreSQL connection string.
4. Add `WEALTH_OS_ACCESS_PASSWORD` as another Render secret. Use a unique password of at least 12 characters; use the same password in each browser. Do not commit it to GitHub or put it in a `VITE_*` variable.
5. Save and redeploy the service.
6. Open `https://wealth-os-market-data.onrender.com/health`. The response must show `"durableStorage":"configured"`.

The current health endpoint confirms that the variable exists, not that the database is reachable. The end-to-end integration test in GitHub Actions separately verifies PostgreSQL writes, reads, and idempotent upserts against a real PostgreSQL service.

## 3. Verify the API end to end

After the Render deployment finishes, test:

- `GET /health` — service health and whether `DATABASE_URL` is configured.
- `POST /api/saved-prices` — persist daily price records.
- `GET /api/saved-prices?symbol=VGWL.DE` — retrieve the saved records.

Then open Wealth OS, go to **Market Data**, and click **Pull Market Data**. The browser-local cache remains available, while the API also persists imported daily bars in PostgreSQL.

## 4. GitHub Actions

The CI workflow runs the frontend TypeScript/Vite production build and backend integration tests. Its PostgreSQL test service is ephemeral and does not use production credentials. It proves that the API can save, read, and upsert market prices against PostgreSQL.

## Security notes

- Never commit `.env`, `.env.local`, or any file containing a real connection string.
- Do not use a `VITE_DATABASE_URL` variable: Vite exposes `VITE_*` values to browser code.
- Set `DATABASE_URL` only in the backend runtime environment.
- The database connection must use TLS as provided by Neon.


## 5. Portfolio login and cross-browser synchronization

Wealth OS uses a shared-password login for its single-owner cloud portfolio. The API validates the password and issues a signed, time-limited session token; the password itself is not stored in the browser. Holdings, opening cash, and transactions are stored in the `portfolio_state` PostgreSQL table and synchronized after changes.

On the first sign-in, if no cloud portfolio exists yet, the current browser's portfolio is migrated to PostgreSQL. Sign in first from the browser that contains the portfolio you want to keep. Then sign in from other browsers with the same password. Once the cloud portfolio exists, it is the source of truth for new sessions.

The `WEALTH_OS_ACCESS_PASSWORD` variable must be set on Render before login works. Render does not receive the value from GitHub because it is declared with `sync: false`. Use a unique password of at least 12 characters. Session tokens expire after seven days.
