from __future__ import annotations

import os
import uuid

import pytest
from fastapi.testclient import TestClient

from main import app


client = TestClient(app)


def test_health_reports_storage_configuration(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DATABASE_URL", raising=False)
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.json()["durableStorage"] == "not-configured"


def test_saved_prices_round_trip_against_postgres() -> None:
    database_url = os.getenv("DATABASE_URL", "").strip()
    if not database_url:
        pytest.skip("DATABASE_URL is required for PostgreSQL integration tests")

    symbol = f"TEST{uuid.uuid4().hex[:8].upper()}"
    payload = {
        "symbol": symbol,
        "currency": "EUR",
        "prices": [
            {
                "date": "2026-01-02",
                "open": 100.0,
                "high": 103.0,
                "low": 99.0,
                "close": 101.5,
                "adjustedClose": 101.25,
                "volume": 12345,
            },
            {
                "date": "2026-01-05",
                "open": 101.5,
                "high": 105.0,
                "low": 101.0,
                "close": 104.0,
                "adjustedClose": 103.75,
                "volume": 23456,
            },
        ],
    }

    saved = client.post("/api/saved-prices", json=payload)
    assert saved.status_code == 200, saved.text
    assert saved.json()["durable"] is True
    assert saved.json()["saved"] == 2
    assert saved.json()["firstDate"] == "2026-01-02"
    assert saved.json()["lastDate"] == "2026-01-05"

    fetched = client.get("/api/saved-prices", params={"symbol": symbol})
    assert fetched.status_code == 200, fetched.text
    result = fetched.json()
    assert result["count"] == 2
    assert result["prices"][0]["date"] == "2026-01-02"
    assert result["prices"][0]["close"] == 101.5
    assert result["prices"][1]["date"] == "2026-01-05"
    assert result["prices"][1]["currency"] == "EUR"

    # Re-importing the same dates must upsert, not create duplicate rows.
    refreshed = client.post("/api/saved-prices", json=payload)
    assert refreshed.status_code == 200, refreshed.text
    fetched_again = client.get("/api/saved-prices", params={"symbol": symbol})
    assert fetched_again.status_code == 200
    assert fetched_again.json()["count"] == 2


def test_saved_prices_rejects_invalid_symbol() -> None:
    response = client.post(
        "/api/saved-prices",
        json={"symbol": "BAD SYMBOL!", "currency": "EUR", "prices": [{"date": "2026-01-02", "close": 1}]},
    )
    assert response.status_code == 400


def test_saved_prices_requires_database_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DATABASE_URL", raising=False)
    response = client.get("/api/saved-prices", params={"symbol": "VGWL.DE"})
    assert response.status_code == 503
