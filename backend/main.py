from __future__ import annotations

import logging
import os
import re
from datetime import date, datetime, timezone
from typing import Any

import pandas as pd
import yfinance as yf
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("wealth-os-market-data")

app = FastAPI(
    title="Wealth OS Market Data API",
    description="Historical market data powered by yfinance and Yahoo Finance.",
    version="1.0.0",
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
    allow_methods=["GET", "OPTIONS"],
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
    return {"status": "ok", "service": "wealth-os-market-data"}


@app.get("/api/history")
def history(
    symbol: str = Query(..., min_length=1, max_length=32),
    period: str = Query("max"),
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

    try:
        ticker = yf.Ticker(normalized_symbol)
        frame = ticker.history(
            period=PERIOD_TO_START[normalized_period],
            interval="1d",
            auto_adjust=False,
            actions=False,
            repair=True,
            raise_errors=True,
            timeout=20,
        )
    except Exception as exc:
        logger.warning("yfinance request failed for %s: %s", normalized_symbol, exc)
        raise HTTPException(
            status_code=502,
            detail=(
                f"Yahoo Finance did not return data for {normalized_symbol}. "
                "Check the ticker or try again later."
            ),
        ) from exc

    if frame is None or frame.empty:
        raise HTTPException(
            status_code=404,
            detail=f"No historical prices were found for {normalized_symbol}.",
        )

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
