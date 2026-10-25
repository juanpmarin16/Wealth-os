from __future__ import annotations

import logging
import os
import re
from datetime import date, datetime, timezone
from typing import Any

import pandas as pd
import psycopg
from psycopg.rows import dict_row
import yfinance as yf
from fastapi import FastAPI, HTTPException, Query, Body
from fastapi.middleware.cors import CORSMiddleware

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("wealth-os-market-data")

app = FastAPI(
    title="Wealth OS Market Data API",
    description="Historical market data powered by yfinance and Yahoo Finance.",
    version="1.1.0",
)

# Market data is public. Override the wildcard with comma-separated origins
# if you later want to restrict which browser apps can call this service.
allowed_origins = [
    origin.strip()
    for origin in os.getenv("CORS_ORIGINS", "*").split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

SYMBOL_PATTERN = re.compile(r"^[A-Za-z0-9^=._-]{1,32}$")
PERIODS = {"1y", "2y", "5y", "10y", "max"}
PERIOD_TO_START = {
    "1y": "1y",
    "2y": "2y",
    "5y": "5y",
    "10y": "10y",
    "max": "max",
}


def safe_float(value: Any) -> float | None:
    try:
        number = float(value)
        if pd.isna(number):
            return None
        return number if number == number and abs(number) != float("inf") else None
    except (TypeError, ValueError, OverflowError):
        return None


@app.get("/")
def root() -> dict[str, str]:
    return {
        "service": "Wealth OS Market Data API",
        "provider": "yfinance / Yahoo Finance",
        "health": "/health",
        "docs": "/docs",
    }


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "wealth-os-market-data", "durableStorage": "configured" if os.getenv("DATABASE_URL", "").strip() else "not-configured"}


@app.get("/api/history")
def history(
    symbol: str = Query(..., min_length=1, max_length=32),
    period: str = Query("max"),
    start: date | None = Query(None),
) -> dict[str, Any]:
    normalized_symbol = symbol.strip().upper()
    normalized_period = period.strip().lower()

    if not SYMBOL_PATTERN.fullmatch(normalized_symbol):
        raise HTTPException(status_code=400, detail="Invalid ticker symbol.")
    if normalized_period not in PERIODS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported period. Choose one of: {', '.join(sorted(PERIODS))}.",
        )
    if start is not None and start > date.today():
        raise HTTPException(status_code=400, detail="Start date cannot be in the future.")

    ticker = yf.Ticker(normalized_symbol)
    frame: pd.DataFrame | None = None
    provider_errors: list[str] = []

    # Try the per-ticker history endpoint first. Some yfinance/Yahoo responses
    # fail here intermittently, so fall back to the download endpoint.
    try:
        history_args: dict[str, Any] = {
            "interval": "1d",
            "auto_adjust": False,
            "actions": False,
            "repair": True,
            "raise_errors": True,
            "timeout": 25,
        }
        if start is not None:
            history_args["start"] = start.isoformat()
        else:
            history_args["period"] = PERIOD_TO_START[normalized_period]
        frame = ticker.history(**history_args)
    except Exception as exc:
        provider_errors.append(f"Ticker.history: {type(exc).__name__}: {exc}")
        logger.warning("yfinance history failed for %s: %s", normalized_symbol, exc)

    if frame is None or frame.empty:
        try:
            download_args: dict[str, Any] = {
                "tickers": normalized_symbol,
                "interval": "1d",
                "auto_adjust": False,
                "actions": False,
                "progress": False,
                "threads": False,
                "timeout": 25,
                "multi_level_index": False,
            }
            if start is not None:
                download_args["start"] = start.isoformat()
            else:
                download_args["period"] = PERIOD_TO_START[normalized_period]
            frame = yf.download(**download_args)
        except Exception as exc:
            provider_errors.append(f"yf.download: {type(exc).__name__}: {exc}")
            logger.warning("yfinance download failed for %s: %s", normalized_symbol, exc)

    if frame is None or frame.empty:
        if provider_errors:
            diagnostic = " | ".join(provider_errors)[:900]
            logger.error("All Yahoo Finance methods failed for %s: %s", normalized_symbol, diagnostic)
            raise HTTPException(
                status_code=502,
                detail=(
                    f"Yahoo Finance request failed for {normalized_symbol}. "
                    f"Technical details: {diagnostic}"
                ),
            )
        raise HTTPException(
            status_code=404,
            detail=f"Yahoo Finance returned an empty history for {normalized_symbol}. Check the ticker or try again later.",
        )

    if isinstance(frame.columns, pd.MultiIndex):
        frame.columns = frame.columns.get_level_values(0)

    frame = frame.copy()
    frame.index = pd.to_datetime(frame.index)
    if getattr(frame.index, "tz", None) is not None:
        frame.index = frame.index.tz_localize(None)

    prices: list[dict[str, Any]] = []
    for timestamp, row in frame.iterrows():
        close = safe_float(row.get("Close"))
        if close is None or close <= 0:
            continue

        adjusted_close = safe_float(row.get("Adj Close"))
        prices.append(
            {
                "date": timestamp.strftime("%Y-%m-%d"),
                "open": safe_float(row.get("Open")),
                "high": safe_float(row.get("High")),
                "low": safe_float(row.get("Low")),
                "close": close,
                "adjustedClose": adjusted_close if adjusted_close and adjusted_close > 0 else close,
                "volume": safe_float(row.get("Volume")),
            }
        )

    if not prices:
        raise HTTPException(
            status_code=404,
            detail=f"No valid daily closing prices were found for {normalized_symbol}.",
        )

    currency = "EUR"
    exchange = ""
    try:
        info = ticker.get_history_metadata() or {}
        currency = str(info.get("currency") or currency).upper()
        exchange = str(info.get("exchangeName") or info.get("exchange") or "")
    except Exception:
        # Some Yahoo listings omit metadata even when price history is available.
        pass

    return {
        "symbol": normalized_symbol,
        "currency": currency,
        "exchange": exchange,
        "provider": "yahoo-finance",
        "retrievedAt": datetime.now(timezone.utc).isoformat(),
        "count": len(prices),
        "prices": prices,
    }


# Durable price history. Configure DATABASE_URL with a managed PostgreSQL database.
def _database_url() -> str:
    value = os.getenv("DATABASE_URL", "").strip()
    if not value:
        raise HTTPException(status_code=503, detail="Durable market-data storage is not configured. Set DATABASE_URL to a managed PostgreSQL database on the market-data service.")
    return "postgresql://" + value[len("postgres://"):] if value.startswith("postgres://") else value


def _ensure_market_table(connection: psycopg.Connection) -> None:
    connection.execute("""
        CREATE TABLE IF NOT EXISTS market_prices (
            symbol TEXT NOT NULL,
            price_date DATE NOT NULL,
            currency TEXT NOT NULL,
            provider TEXT NOT NULL DEFAULT 'yahoo-finance',
            open DOUBLE PRECISION, high DOUBLE PRECISION, low DOUBLE PRECISION,
            close DOUBLE PRECISION NOT NULL, adjusted_close DOUBLE PRECISION,
            volume DOUBLE PRECISION, fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (symbol, price_date, provider)
        )
    """)
    connection.execute("CREATE INDEX IF NOT EXISTS market_prices_symbol_date_idx ON market_prices (symbol, price_date)")


@app.post("/api/saved-prices")
def save_prices(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    symbol = str(payload.get("symbol", "")).strip().upper()
    currency = str(payload.get("currency", "")).strip().upper()
    prices = payload.get("prices")
    if not SYMBOL_PATTERN.fullmatch(symbol):
        raise HTTPException(status_code=400, detail="Invalid ticker symbol.")
    if not re.fullmatch(r"[A-Z]{3}", currency):
        raise HTTPException(status_code=400, detail="A valid three-letter currency is required.")
    if not isinstance(prices, list) or not prices:
        raise HTTPException(status_code=400, detail="prices must be a non-empty array.")
    if len(prices) > 20000:
        raise HTTPException(status_code=413, detail="A single import cannot exceed 20,000 daily records.")

    prepared: list[tuple[Any, ...]] = []
    for item in prices:
        if not isinstance(item, dict):
            continue
        try:
            price_date = date.fromisoformat(str(item.get("date", "")))
            close = safe_float(item.get("close"))
            if close is None or close <= 0:
                continue
            prepared.append((symbol, price_date, currency, "yahoo-finance",
                safe_float(item.get("open")), safe_float(item.get("high")), safe_float(item.get("low")),
                close, safe_float(item.get("adjustedClose")), safe_float(item.get("volume"))))
        except (TypeError, ValueError):
            continue
    if not prepared:
        raise HTTPException(status_code=400, detail="No valid dated closing prices were supplied.")

    try:
        with psycopg.connect(_database_url(), row_factory=dict_row, connect_timeout=10) as connection:
            _ensure_market_table(connection)
            connection.cursor().executemany("""
                INSERT INTO market_prices
                (symbol, price_date, currency, provider, open, high, low, close, adjusted_close, volume, fetched_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
                ON CONFLICT (symbol, price_date, provider) DO UPDATE SET
                  currency=EXCLUDED.currency, open=EXCLUDED.open, high=EXCLUDED.high,
                  low=EXCLUDED.low, close=EXCLUDED.close, adjusted_close=EXCLUDED.adjusted_close,
                  volume=EXCLUDED.volume, fetched_at=NOW()
            """, prepared)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Unable to persist market prices")
        raise HTTPException(status_code=503, detail="Could not persist market data. Verify DATABASE_URL and database connectivity.") from exc
    return {"symbol": symbol, "saved": len(prepared), "firstDate": min(x[1] for x in prepared).isoformat(),
            "lastDate": max(x[1] for x in prepared).isoformat(), "durable": True}


@app.get("/api/saved-prices")
def get_saved_prices(symbol: str = Query(..., min_length=1, max_length=32),
                     start: date | None = Query(None), end: date | None = Query(None)) -> dict[str, Any]:
    normalized = symbol.strip().upper()
    if not SYMBOL_PATTERN.fullmatch(normalized):
        raise HTTPException(status_code=400, detail="Invalid ticker symbol.")
    if start and end and start > end:
        raise HTTPException(status_code=400, detail="start cannot be after end.")
    try:
        with psycopg.connect(_database_url(), row_factory=dict_row, connect_timeout=10) as connection:
            _ensure_market_table(connection)
            query = "SELECT price_date, currency, open, high, low, close, adjusted_close, volume FROM market_prices WHERE symbol=%s"
            params: list[Any] = [normalized]
            if start:
                query += " AND price_date >= %s"
                params.append(start)
            if end:
                query += " AND price_date <= %s"
                params.append(end)
            query += " ORDER BY price_date ASC"
            rows = connection.execute(query, params).fetchall()
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Unable to read saved market prices")
        raise HTTPException(status_code=503, detail="Could not read durable market data. Verify DATABASE_URL and database connectivity.") from exc
    prices = [{"date": row["price_date"].isoformat(), "currency": row["currency"],
        "open": row["open"], "high": row["high"], "low": row["low"], "close": row["close"],
        "adjustedClose": row["adjusted_close"], "volume": row["volume"]} for row in rows]
    return {"symbol": normalized, "count": len(prices), "firstDate": prices[0]["date"] if prices else None,
            "lastDate": prices[-1]["date"] if prices else None, "prices": prices}
