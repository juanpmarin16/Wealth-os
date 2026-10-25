import { useState } from "react";
import { saveInstrument, saveListing, saveMarketPrices } from "./data/database";
import type { AssetType } from "./data/models";

const MARKET_DATA_API_URL = "https://wealth-os-market-data.onrender.com";
const PERIOD = "1y";

type PortfolioAsset = {
  id: string;
  name: string;
  ticker: string;
  category: string;
};

type PriceRecord = {
  date: string;
  open?: number;
  high?: number;
  low?: number;
  close: number;
  adjustedClose?: number;
  volume?: number;
};

type YahooHistoryResponse = {
  symbol: string;
  currency?: string;
  exchange?: string;
  prices: PriceRecord[];
};

type MarketDataImportProps = {
  assets: PortfolioAsset[];
  onPricesImported?: (symbol: string, latestPrice: number, currency: string) => void;
};

const SYMBOLS: Record<string, string> = {
  VGWL: "VGWL.DE",
  EQQQ: "EQQQ.DE",
  BTC: "BTC-USD",
  LDGL: "LDGL.L",
};

function safeId(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "_");
}

function inferAssetType(category: string): AssetType {
  const normalized = category.toLowerCase();
  if (normalized.includes("crypto") || normalized.includes("bitcoin")) return "crypto";
  if (normalized.includes("bond") || normalized.includes("fixed income")) return "bond";
  if (normalized.includes("commodit") || normalized.includes("gold")) return "commodity";
  if (normalized.includes("real estate") || normalized.includes("property")) return "real_estate";
  if (normalized.includes("cash")) return "cash";
  if (normalized.includes("private equity")) return "private_equity";
  if (normalized.includes("fund")) return "fund";
  if (normalized.includes("stock")) return "stock";
  return "etf";
}

function yahooSymbolFor(ticker: string): string | undefined {
  const normalized = ticker.trim().toUpperCase();
  if (!normalized || normalized === "OTHER" || normalized === "EUR" || normalized === "CASH") {
    return undefined;
  }
  return SYMBOLS[normalized] ?? normalized;
}

async function fetchHistory(symbol: string): Promise<YahooHistoryResponse> {
  const url = new URL("/api/history", MARKET_DATA_API_URL);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("period", PERIOD);

  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
  });
  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const detail =
      typeof payload === "object" && payload !== null && "detail" in payload
        ? String(payload.detail)
        : `Market data API returned HTTP ${response.status}.`;
    throw new Error(detail);
  }

  if (
    typeof payload !== "object" ||
    payload === null ||
    !("prices" in payload) ||
    !Array.isArray(payload.prices)
  ) {
    throw new Error("The market data API returned an unexpected response.");
  }

  const data = payload as YahooHistoryResponse;
  const validPrices = data.prices.filter(
    (item) =>
      typeof item.date === "string" &&
      Number.isFinite(item.close) &&
      item.close > 0,
  );

  if (validPrices.length === 0) {
    throw new Error(`Yahoo Finance returned no valid prices for ${symbol}.`);
  }

  return { ...data, prices: validPrices };
}

async function saveHistory(
  asset: PortfolioAsset,
  symbol: string,
  data: YahooHistoryResponse,
): Promise<number> {
  const currency = (data.currency || "USD").trim().toUpperCase();
  const instrumentId = `instrument_${safeId(asset.ticker)}`;
  const listingId = `listing_yahoo_${safeId(symbol)}`;
  const now = new Date().toISOString();

  await saveInstrument({
    id: instrumentId,
    name: asset.name,
    assetType: inferAssetType(asset.category),
    baseCurrency: currency,
    status: "active",
    notes: "Created or updated by the one-click market data synchronizer.",
  });

  await saveListing({
    id: listingId,
    instrumentId,
    provider: "yahoo-finance",
    symbol,
    exchange: data.exchange || undefined,
    quoteCurrency: currency,
    isPrimary: true,
    status: "active",
    lastVerifiedAt: now,
  });

  return saveMarketPrices(
    data.prices.map((price) => ({
      listingId,
      date: price.date,
      provider: "yahoo-finance" as const,
      currency,
      close: price.close,
      adjustedClose: price.adjustedClose ?? price.close,
      open: price.open,
      high: price.high,
      low: price.low,
      volume: price.volume,
    })),
  );
}

export default function MarketDataImport({
  assets,
  onPricesImported,
}: MarketDataImportProps) {
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [lastSync, setLastSync] = useState(() => {
    try {
      return localStorage.getItem("wealth-os-market-data-last-sync") ?? "";
    } catch {
      return "";
    }
  });

  async function pullMarketData() {
    setRunning(true);
    setMessage("");
    setError("");

    let updated = 0;
    let totalPrices = 0;
    const failures: string[] = [];
    const skipped: string[] = [];

    try {
      for (const asset of assets) {
        const symbol = yahooSymbolFor(asset.ticker);
        if (!symbol) {
          skipped.push(asset.ticker);
          continue;
        }

        try {
          const data = await fetchHistory(symbol);
          const count = await saveHistory(asset, symbol, data);
          updated += 1;
          totalPrices += count;

          const latest = data.prices.reduce((a, b) =>
            a.date > b.date ? a : b,
          );
          onPricesImported?.(symbol, latest.close, data.currency || "USD");
        } catch (cause) {
          failures.push(
            `${asset.ticker} (${symbol}): ${cause instanceof Error ? cause.message : "Unknown error"}`,
          );
        }
      }

      if (updated > 0) {
        const timestamp = new Date().toISOString();
        setLastSync(timestamp);
        try {
          localStorage.setItem("wealth-os-market-data-last-sync", timestamp);
        } catch {
          // Synchronization still succeeded even if the timestamp cannot be persisted.
        }
      }

      const skippedText = skipped.length
        ? ` Skipped assets without a market symbol: ${skipped.join(", ")}.`
        : "";
      setMessage(
        `Updated ${updated} of ${assets.length} portfolio assets and saved ${totalPrices.toLocaleString()} daily price records.${skippedText}`,
      );

      if (failures.length > 0) {
        setError(`Some assets could not be updated:\n${failures.join("\n")}`);
      } else if (updated === 0) {
        setError("No market data was updated. Check that your portfolio contains supported market symbols.");
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Market data synchronization failed. Previously saved prices have not been deleted.",
      );
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="market-import-page" style={{ display: "grid", gap: 20 }}>
      <section className="panel" style={{ padding: 22 }}>
        <h2 style={{ marginTop: 0 }}>Market Data</h2>
        <p style={{ color: "var(--muted)", lineHeight: 1.7 }}>
          Pull the latest available market data for your portfolio. Wealth OS
          downloads daily price history automatically and saves it locally in
          this browser. Existing records are preserved if a download fails.
        </p>

        <button
          className="primary-button"
          onClick={pullMarketData}
          disabled={running || assets.length === 0}
          style={{ minHeight: 46, padding: "12px 20px", fontSize: 14 }}
        >
          {running ? "Pulling Market Data..." : "↻ Pull Market Data"}
        </button>

        <div style={{ marginTop: 18, padding: 14, border: "1px solid var(--border)", borderRadius: 10 }}>
          <div style={{ color: "var(--muted)", fontSize: 12, marginBottom: 6 }}>Last successful synchronization</div>
          <strong>{lastSync ? new Date(lastSync).toLocaleString("en-GB") : "Not synchronized yet"}</strong>
          <div style={{ color: "var(--muted)", fontSize: 12, marginTop: 10 }}>
            {assets.length} portfolio assets detected · Daily history · Yahoo Finance via yfinance
          </div>
        </div>

        {message && (
          <div role="status" style={{ whiteSpace: "pre-line", marginTop: 14, padding: 12, borderRadius: 8, background: "rgba(54,201,165,.12)", color: "#36c9a5" }}>
            {message}
          </div>
        )}
        {error && (
          <div role="alert" style={{ whiteSpace: "pre-wrap", marginTop: 14, padding: 12, borderRadius: 8, background: "rgba(231,121,105,.12)", color: "#e77969" }}>
            {error}
          </div>
        )}
      </section>
    </div>
  );
}
