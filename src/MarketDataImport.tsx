import { useState } from "react";
import { getMarketPrices, saveInstrument, saveListing, saveMarketPrices } from "./data/database";
import type { AssetType } from "./data/models";

const MARKET_DATA_API_URL = "https://wealth-os-market-data.onrender.com";
const SYMBOL_MAP_KEY = "wealth-os-market-data-symbol-mappings";
const FULL_HISTORY_KEY = "wealth-os-full-history-imported-listings";

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
  compact?: boolean;
  onPricesImported?: (symbol: string, latestPrice: number, currency: string) => void | Promise<void>;
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

function yahooSymbolFor(
  ticker: string,
  customSymbols: Record<string, string> = {},
): string | undefined {
  const normalized = ticker.trim().toUpperCase();
  const custom = customSymbols[normalized]?.trim().toUpperCase();
  if (custom) return custom;
  if (!normalized || normalized === "OTHER" || normalized === "EUR" || normalized === "CASH") {
    return undefined;
  }
  return SYMBOLS[normalized] ?? normalized;
}

function readSymbolMappings(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SYMBOL_MAP_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([key, value]) => typeof key === "string" && typeof value === "string" && value.trim() !== "",
      ),
    );
  } catch {
    return {};
  }
}

function readFullHistoryListings(): string[] {
  try {
    const raw = localStorage.getItem(FULL_HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

async function fetchHistory(symbol: string, startDate?: string): Promise<YahooHistoryResponse> {
  const url = new URL("/api/history", MARKET_DATA_API_URL);
  url.searchParams.set("symbol", symbol);
  if (startDate) {
    url.searchParams.set("start", startDate);
  } else {
    url.searchParams.set("period", "max");
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 40000);
  let response: Response;
  let payload: unknown;
  try {
    response = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    payload = await response.json().catch(() => null);
  } finally {
    window.clearTimeout(timeout);
  }

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
  compact = false,
  onPricesImported,
}: MarketDataImportProps) {
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [customSymbols, setCustomSymbols] = useState<Record<string, string>>(readSymbolMappings);
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
    const durabilityWarnings: string[] = [];
    const importedCurrencies = new Set<string>();
    const skipped: string[] = [];
    const fullHistoryListings = new Set(readFullHistoryListings());

    try {
      for (const asset of assets) {
        const symbol = yahooSymbolFor(asset.ticker, customSymbols);
        if (!symbol) {
          skipped.push(asset.ticker);
          continue;
        }

        try {
          const listingId = "listing_yahoo_" + safeId(symbol);
          let existingPrices = await getMarketPrices(listingId);

          // Rehydrate an empty browser cache from the durable PostgreSQL archive.
          {
            try {
              const savedResponse = await fetch(
                new URL(`/api/saved-prices?symbol=${encodeURIComponent(symbol)}`, MARKET_DATA_API_URL).toString(),
                { headers: { Accept: "application/json" } },
              );
              const savedPayload: unknown = await savedResponse.json().catch(() => null);
              if (savedResponse.ok && typeof savedPayload === "object" && savedPayload !== null &&
                  "prices" in savedPayload && Array.isArray(savedPayload.prices) && savedPayload.prices.length > 0) {
                const saved = savedPayload as {
                  prices: Array<PriceRecord & { currency?: string }>;
                  count?: number;
                };
                const currency = saved.prices.find((price) => price.currency)?.currency || "USD";
                await saveHistory(asset, symbol, {
                  symbol,
                  currency,
                  prices: saved.prices.map((price) => ({
                    date: price.date, open: price.open, high: price.high, low: price.low,
                    close: price.close, adjustedClose: price.adjustedClose, volume: price.volume,
                  })),
                });
                existingPrices = await getMarketPrices(listingId);
                if (saved.count && existingPrices.length >= saved.count) {
                  fullHistoryListings.add(listingId);
                  try { localStorage.setItem(FULL_HISTORY_KEY, JSON.stringify([...fullHistoryListings])); } catch { /* Cache hint only. */ }
                }
              }
            } catch {
              // Continue with a normal Yahoo Finance fetch if the archive is unavailable.
            }
          }

          const lastStoredDate = existingPrices.length > 0
            ? existingPrices[existingPrices.length - 1].date
            : undefined;
          // The archive is the source of truth. Always update from its latest date;
          // first-time imports (no saved date) still backfill the available full history.
          const data = await fetchHistory(symbol, lastStoredDate);
          const count = await saveHistory(asset, symbol, data);
          try {
            const durableResponse = await fetch(new URL("/api/saved-prices", MARKET_DATA_API_URL).toString(), {
              method: "POST",
              headers: { "Content-Type": "application/json", Accept: "application/json" },
              body: JSON.stringify({ symbol, currency: data.currency || "USD", prices: data.prices }),
            });
            if (!durableResponse.ok) {
              const durablePayload: unknown = await durableResponse.json().catch(() => null);
              const detail = typeof durablePayload === "object" && durablePayload !== null && "detail" in durablePayload
                ? String(durablePayload.detail)
                : `HTTP ${durableResponse.status}`;
              durabilityWarnings.push(`${asset.ticker}: ${detail}`);
            }
          } catch (cause) {
            durabilityWarnings.push(`${asset.ticker}: ${cause instanceof Error ? cause.message : "persistent storage unavailable"}`);
          }
          if (!fullHistoryAlreadyImported) {
            fullHistoryListings.add(listingId);
            try {
              localStorage.setItem(FULL_HISTORY_KEY, JSON.stringify([...fullHistoryListings]));
            } catch {
              // If storage is unavailable, the next run safely repeats the full-history import.
            }
          }
          updated += 1;
          totalPrices += count;
          const quoteCurrency = (data.currency || "").trim().toUpperCase();
          if (quoteCurrency && quoteCurrency !== "EUR") importedCurrencies.add(quoteCurrency);

          const latest = data.prices.reduce((a, b) =>
            a.date > b.date ? a : b,
          );
          await onPricesImported?.(symbol, latest.close, data.currency || "USD");
        } catch (cause) {
          failures.push(
            `${asset.ticker} (${symbol}): ${cause instanceof Error ? cause.message : "Unknown error"}`,
          );
        }
      }

      // Keep the FX history required by multi-currency analytics in the same durable archive.
      for (const currency of importedCurrencies) {
        const fxSymbol = `EUR${currency}=X`;
        try {
          const savedResponse = await fetch(
            new URL(`/api/saved-prices?symbol=${encodeURIComponent(fxSymbol)}`, MARKET_DATA_API_URL).toString(),
            { headers: { Accept: "application/json" } },
          );
          const savedPayload: unknown = await savedResponse.json().catch(() => null);
          const savedPrices = typeof savedPayload === "object" && savedPayload !== null && "prices" in savedPayload && Array.isArray(savedPayload.prices)
            ? (savedPayload.prices as PriceRecord[])
            : [];
          const lastFxDate = savedPrices.reduce((latest, point) => point.date > latest ? point.date : latest, "");
          const fxData = await fetchHistory(fxSymbol, lastFxDate || undefined);
          const persistResponse = await fetch(new URL("/api/saved-prices", MARKET_DATA_API_URL).toString(), {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ symbol: fxSymbol, currency: "EUR", prices: fxData.prices }),
          });
          if (!persistResponse.ok) throw new Error(`Archive returned HTTP ${persistResponse.status}`);
          totalPrices += fxData.prices.length;
        } catch (cause) {
          failures.push(`FX EUR/${currency}: ${cause instanceof Error ? cause.message : "FX update failed"}`);
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

      if (updated > 0) {
        window.dispatchEvent(new Event("wealth-os-market-data-updated"));
      }

      const skippedText = skipped.length
        ? ` Skipped assets without a market symbol: ${skipped.join(", ")}.`
        : "";
      setMessage(
        `Updated ${updated} of ${assets.length} portfolio assets and processed ${totalPrices.toLocaleString()} daily price records. Assets without a completed full-history import are backfilled with all history available from Yahoo Finance; later pulls refresh from the latest saved date.${skippedText}`,
      );

      const issues: string[] = [];
      if (failures.length > 0) {
        issues.push(`Some assets could not be updated:\n${failures.join("\n")}`);
      }
      if (durabilityWarnings.length > 0) {
        issues.push(
          `Market data was imported locally, but could not be confirmed in the durable database:\n${durabilityWarnings.join("\n")}\n\nCheck the market-data API and PostgreSQL connection, then run Pull Market Data again.`,
        );
      }
      if (issues.length > 0) {
        setError(issues.join("\n\n"));
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

  if (compact) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button className="button button-primary" onClick={pullMarketData} disabled={running || assets.length === 0}>
          {running ? "Updating…" : "↻ Update Market Data"}
        </button>
        {message && <span role="status" style={{ color: "var(--muted)", fontSize: 12 }}>{message}</span>}
        {error && <span role="alert" style={{ color: "#e77969", fontSize: 12 }}>Update failed — open Market Data for details</span>}
      </div>
    );
  }

  return (
    <div className="market-import-page" style={{ display: "grid", gap: 20 }}>
      <section className="panel" style={{ padding: 22 }}>
        <h2 style={{ marginTop: 0 }}>Market Data</h2>
        <p style={{ color: "var(--muted)", lineHeight: 1.7 }}>
          Pull daily market data for your portfolio. Each asset is first backfilled with all history available from Yahoo Finance, including any existing partial history; later pulls fetch only data from the latest saved date, refreshing overlapping records. Daily price history is archived in PostgreSQL and cached locally for fast access. Your portfolio itself is synchronized to the protected cloud account after sign-in.
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
            {assets.length} portfolio assets detected · Full available history on first import · Yahoo Finance via yfinance
          </div>
        </div>


        {assets.some((asset) => !yahooSymbolFor(asset.ticker, customSymbols)) && (
          <div style={{ marginTop: 18, padding: 14, border: "1px solid var(--border)", borderRadius: 10 }}>
            <h3 style={{ marginTop: 0 }}>Unmapped Assets</h3>
            <p style={{ color: "var(--muted)", lineHeight: 1.7 }}>
              Generic labels such as OTHER do not identify a tradable security. Enter the real Yahoo Finance symbol for each unmapped asset to include it in market data imports.
            </p>
            {assets.filter((asset) => !yahooSymbolFor(asset.ticker, customSymbols)).map((asset) => (
              <label key={asset.id} style={{ display: "grid", gap: 6, marginTop: 12 }}>
                <span>{asset.name} ({asset.ticker})</span>
                <input
                  value={customSymbols[asset.ticker.toUpperCase()] ?? ""}
                  onChange={(event) => setCustomSymbols((current) => ({
                    ...current,
                    [asset.ticker.toUpperCase()]: event.target.value.toUpperCase(),
                  }))}
                  placeholder="e.g. AAPL, VWCE.DE, or BTC-USD"
                  maxLength={32}
                />
              </label>
            ))}
            <button
              className="secondary-button"
              style={{ marginTop: 12 }}
              onClick={() => {
                const cleaned = Object.fromEntries(
                  Object.entries(customSymbols)
                    .map(([key, value]) => [key.trim().toUpperCase(), value.trim().toUpperCase()])
                    .filter(([, value]) => value !== ""),
                ) as Record<string, string>;
                setCustomSymbols(cleaned);
                try {
                  localStorage.setItem(SYMBOL_MAP_KEY, JSON.stringify(cleaned));
                  setMessage("Market symbol mappings saved in this browser. Pull Market Data to import the mapped assets.");
                } catch {
                  setError("The symbol mappings could not be saved in this browser.");
                }
              }}
            >
              Save Symbol Mappings
            </button>
          </div>
        )}
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
