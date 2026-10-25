import { useMemo, useState, type ChangeEvent } from "react";
import { saveInstrument, saveListing, saveMarketPrices } from "./data/database";
import type { AssetType, MarketDataProvider } from "./data/models";

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

const ASSET_TYPES: AssetType[] = [
  "etf", "stock", "fund", "crypto", "bond", "commodity",
  "real_estate", "cash", "private_equity", "other",
];
const PERIODS = [
  { value: "1y", label: "1 year" },
  { value: "5y", label: "5 years" },
  { value: "10y", label: "10 years" },
  { value: "max", label: "Maximum available history" },
];
const API_URL_KEY = "wealth-os-market-data-api-url";
const DEFAULT_API_URL = import.meta.env.VITE_MARKET_DATA_API_URL ?? "";

function parseCsvLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        value += '"';
        i += 1;
      } else quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      result.push(value.trim());
      value = "";
    } else value += char;
  }
  result.push(value.trim());
  return result;
}

function normalizeHeader(value: string): string {
  return value.trim().replace(/^\uFEFF/, "").toLowerCase().replace(/[ _-]/g, "");
}

function parseNumeric(value: string): number | undefined {
  const normalized = value.trim().replace(/,/g, "");
  if (!normalized || normalized === "N/A" || normalized === "-") return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseDate(value: string): string | undefined {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const date = new Date(`${trimmed}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === trimmed ? trimmed : undefined;
  }
  const match = trimmed.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (match) {
    const [, first, second, year] = match;
    const date = `${year}-${second.padStart(2, "0")}-${first.padStart(2, "0")}`;
    const parsed = new Date(`${date}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : undefined;
  }
  return undefined;
}

function parsePriceCsv(text: string): PriceRecord[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error("The CSV file must contain a header and at least one data row.");
  const delimiter = (lines[0].match(/;/g) ?? []).length > (lines[0].match(/,/g) ?? []).length ? ";" : ",";
  const headers = parseCsvLine(lines[0], delimiter).map(normalizeHeader);
  const find = (...names: string[]) => headers.findIndex((header) => names.includes(header));
  const dateIndex = find("date", "datetime");
  const closeIndex = find("close", "closingprice", "price");
  const adjustedCloseIndex = find("adjclose", "adjustedclose", "adjustedclosingprice");
  const openIndex = find("open", "openingprice");
  const highIndex = find("high");
  const lowIndex = find("low");
  const volumeIndex = find("volume", "vol");
  if (dateIndex < 0 || closeIndex < 0) throw new Error("Required columns not found. Expected at least Date and Close.");

  const prices: PriceRecord[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = parseCsvLine(lines[i], delimiter);
    const date = parseDate(cells[dateIndex] ?? "");
    const close = parseNumeric(cells[closeIndex] ?? "");
    if (!date || close === undefined || close <= 0) continue;
    const optional = (index: number) => index < 0 ? undefined : parseNumeric(cells[index] ?? "");
    prices.push({
      date, close, adjustedClose: optional(adjustedCloseIndex),
      open: optional(openIndex), high: optional(highIndex), low: optional(lowIndex),
      volume: optional(volumeIndex),
    });
  }
  if (prices.length === 0) throw new Error("No valid daily price rows were found in this CSV.");
  const unique = new Map<string, PriceRecord>();
  for (const price of prices) unique.set(price.date, price);
  return [...unique.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function safeId(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "_");
}

function getSavedApiUrl(): string {
  try {
    return localStorage.getItem(API_URL_KEY) ?? DEFAULT_API_URL;
  } catch {
    return DEFAULT_API_URL;
  }
}

type MarketDataImportProps = {\n  onPricesImported?: (symbol: string, latestPrice: number, currency: string) => void;\n};\n\nexport default function MarketDataImport({ onPricesImported }: MarketDataImportProps) {
  const [symbol, setSymbol] = useState("VGWL.DE");
  const [instrumentName, setInstrumentName] = useState("Vanguard FTSE All-World UCITS ETF");
  const [assetType, setAssetType] = useState<AssetType>("etf");
  const [currency, setCurrency] = useState("EUR");
  const [exchange, setExchange] = useState("XETRA");
  const [period, setPeriod] = useState("max");
  const [apiUrl, setApiUrl] = useState(getSavedApiUrl);
  const [fileName, setFileName] = useState("");
  const [prices, setPrices] = useState<PriceRecord[]>([]);
  const [importSource, setImportSource] = useState<"csv-import" | "yahoo-finance">("yahoo-finance");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const preview = useMemo(() => prices.slice(-5).reverse(), [prices]);

  function updateApiUrl(value: string) {
    setApiUrl(value);
    try {
      localStorage.setItem(API_URL_KEY, value.trim().replace(/\/+$/, ""));
    } catch {
      // Keep the value for this session if browser storage is unavailable.
    }
  }

  function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setError("");
    setMessage("");
    setPrices([]);
    setFileName(file?.name ?? "");
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        setPrices(parsePriceCsv(String(reader.result ?? "")));
        setImportSource("csv-import");
        setMessage("CSV validated. Import it to save prices locally.");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not parse this CSV file.");
      }
    };
    reader.onerror = () => setError("The selected file could not be read.");
    reader.readAsText(file);
  }

  async function savePrices(
    inputPrices: PriceRecord[],
    source: MarketDataProvider,
    sourceCurrency: string,
    sourceExchange?: string,
  ) {
    const normalizedSymbol = symbol.trim().toUpperCase();
    const normalizedCurrency = sourceCurrency.trim().toUpperCase();
    if (!normalizedSymbol || !instrumentName.trim() || !/^[A-Z]{3}$/.test(normalizedCurrency)) {
      throw new Error("Enter a symbol, instrument name, and a valid 3-letter currency code.");
    }
    if (inputPrices.length === 0) throw new Error("The provider returned no valid daily prices.");

    const instrumentId = `instrument_${safeId(normalizedSymbol)}`;
    const listingId = `listing_${source === "yahoo-finance" ? "yahoo" : "csv"}_${safeId(normalizedSymbol)}`;
    const now = new Date().toISOString();

    await saveInstrument({
      id: instrumentId, name: instrumentName.trim(), assetType,
      baseCurrency: normalizedCurrency, status: "active",
      notes: `Created or updated through ${source} market data import.`,
    });
    await saveListing({
      id: listingId, instrumentId, provider: source, symbol: normalizedSymbol,
      exchange: (sourceExchange || exchange).trim() || undefined,
      quoteCurrency: normalizedCurrency, isPrimary: true, status: "active",
      lastVerifiedAt: now,
    });
    const count = await saveMarketPrices(inputPrices.map((price) => ({
      listingId, date: price.date, provider: source, currency: normalizedCurrency,
      close: price.close, adjustedClose: price.adjustedClose ?? price.close,
      open: price.open, high: price.high, low: price.low, volume: price.volume,
    })));
    return { count, normalizedSymbol };
  }

  async function fetchFromYahoo() {
    setError("");
    setMessage("");
    setPrices([]);
    setSaving(true);
    setImportSource("yahoo-finance");
    const normalizedSymbol = symbol.trim().toUpperCase();
    const baseUrl = apiUrl.trim().replace(/\/+$/, "");
    if (!baseUrl) {
      setError("Configure the Market Data API URL first. Deploy the Python API from this repository and paste its URL here.");
      setSaving(false);
      return;
    }
    if (!normalizedSymbol) {
      setError("Enter a Yahoo Finance symbol, for example VGWL.DE.");
      setSaving(false);
      return;
    }

    try {
      const response = await fetch(
        `${baseUrl}/api/history?symbol=${encodeURIComponent(normalizedSymbol)}&period=${encodeURIComponent(period)}`,
        { headers: { Accept: "application/json" } },
      );
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const detail = typeof payload === "object" && payload !== null && "detail" in payload
          ? String(payload.detail) : `Market data API returned HTTP ${response.status}.`;
        throw new Error(detail);
      }
      if (typeof payload !== "object" || payload === null || !("prices" in payload) || !Array.isArray(payload.prices)) {
        throw new Error("The market data API returned an unexpected response.");
      }
      const data = payload as YahooHistoryResponse;
      const validPrices = data.prices.filter((item) =>
        typeof item.date === "string" && Number.isFinite(item.close) && item.close > 0
      );
      if (validPrices.length === 0) throw new Error(`Yahoo Finance returned no valid prices for ${normalizedSymbol}.`);

      const responseCurrency = data.currency || currency;
      const responseExchange = data.exchange || exchange;
      const result = await savePrices(validPrices, "yahoo-finance", responseCurrency, responseExchange);
      setCurrency(responseCurrency);
      setExchange(responseExchange);
      setPrices(validPrices);
      setMessage(`Imported ${result.count.toLocaleString()} daily prices for ${result.normalizedSymbol} from Yahoo Finance via yfinance. Data is saved locally in this browser.`);
    } catch (cause) {
      setError(cause instanceof Error
        ? `${cause.message} Existing locally saved prices have not been deleted.`
        : "Market data import failed. Existing locally saved prices have not been deleted.");
    } finally {
      setSaving(false);
    }
  }

  async function importCsvPrices() {
    setError("");
    setMessage("");
    setSaving(true);
    try {
      const result = await savePrices(prices, "csv-import", currency, exchange);
      setMessage(`Imported ${result.count.toLocaleString()} daily prices for ${result.normalizedSymbol}. Data is saved locally in this browser.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "CSV import failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="market-import-page" style={{ display: "grid", gap: 20 }}>
      <section className="panel" style={{ padding: 22 }}>
        <h2 style={{ marginTop: 0 }}>Market Data Import</h2>
        <p style={{ color: "var(--muted)", lineHeight: 1.7 }}>
          Fetch daily historical prices from Yahoo Finance through the Python yfinance service, or import a CSV. Prices are stored locally in Wealth OS IndexedDB. Failed requests do not delete previously saved prices.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
          <label>Instrument symbol
            <input value={symbol} onChange={(event) => setSymbol(event.target.value)} placeholder="VGWL.DE" />
          </label>
          <label>Instrument name
            <input value={instrumentName} onChange={(event) => setInstrumentName(event.target.value)} placeholder="ETF name" />
          </label>
          <label>Asset type
            <select value={assetType} onChange={(event) => setAssetType(event.target.value as AssetType)}>
              {ASSET_TYPES.map((type) => <option key={type} value={type}>{type.replace("_", " ")}</option>)}
            </select>
          </label>
          <label>Quote currency
            <input value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} maxLength={3} placeholder="EUR" />
          </label>
          <label>Exchange (optional)
            <input value={exchange} onChange={(event) => setExchange(event.target.value)} placeholder="XETRA" />
          </label>
          <label>Historical period
            <select value={period} onChange={(event) => setPeriod(event.target.value)}>
              {PERIODS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
        </div>

        <label style={{ display: "block", marginTop: 18 }}>yfinance API base URL
          <input value={apiUrl} onChange={(event) => updateApiUrl(event.target.value)} placeholder="https://your-wealth-os-api.onrender.com" inputMode="url" autoComplete="url" />
        </label>
        <p style={{ color: "var(--muted)", fontSize: 12, lineHeight: 1.6, marginTop: 6 }}>
          Paste the API URL after deploying the Python service. It is saved in this browser and is not a secret.
        </p>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 18 }}>
          <button className="primary-button" onClick={fetchFromYahoo} disabled={saving}>
            {saving && importSource === "yahoo-finance" ? "Fetching and saving..." : "Fetch from yfinance"}
          </button>
        </div>

        <div style={{ borderTop: "1px solid var(--border)", marginTop: 22, paddingTop: 18 }}>
          <h3 style={{ marginTop: 0 }}>Alternative: import CSV</h3>
          <label style={{ display: "block" }}>Historical CSV file
            <input type="file" accept=".csv,text/csv,text/plain" onChange={handleFile} style={{ display: "block", marginTop: 8, width: "100%" }} />
          </label>
          {fileName && <p style={{ color: "var(--muted)", fontSize: 13 }}>Selected file: {fileName}</p>}
          <button className="secondary-button" onClick={importCsvPrices} disabled={saving || prices.length === 0 || importSource !== "csv-import"} style={{ marginTop: 12 }}>
            {saving && importSource === "csv-import" ? "Importing..." : `Import ${prices.length ? prices.length.toLocaleString() + " CSV prices" : "CSV prices"}`}
          </button>
        </div>

        {error && <div role="alert" style={{ marginTop: 14, padding: 12, borderRadius: 8, background: "rgba(231,121,105,.12)", color: "#e77969" }}>{error}</div>}
        {message && <div role="status" style={{ marginTop: 14, padding: 12, borderRadius: 8, background: "rgba(54,201,165,.12)", color: "#36c9a5" }}>{message}</div>}
      </section>

      {prices.length > 0 && (
        <section className="panel" style={{ padding: 22 }}>
          <h3 style={{ marginTop: 0 }}>Import Preview</h3>
          <p style={{ color: "var(--muted)", fontSize: 13 }}>
            {prices.length.toLocaleString()} daily records · {prices[0].date} to {prices[prices.length - 1].date}
          </p>
          <div className="table-scroll">
            <table className="holdings-table">
              <thead><tr><th>DATE</th><th>OPEN</th><th>HIGH</th><th>LOW</th><th>CLOSE</th><th>ADJ. CLOSE</th><th>VOLUME</th></tr></thead>
              <tbody>
                {preview.map((price) => (
                  <tr key={price.date}>
                    <td>{price.date}</td><td>{price.open ?? "—"}</td><td>{price.high ?? "—"}</td>
                    <td>{price.low ?? "—"}</td><td><strong>{price.close}</strong></td>
                    <td>{price.adjustedClose ?? "—"}</td><td>{price.volume?.toLocaleString() ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ color: "var(--muted)", fontSize: 12, lineHeight: 1.6 }}>
            Preview shows the five most recent dates. Re-importing a symbol/date updates that provider's record instead of duplicating it.
          </p>
        </section>
      )}
    </div>
  );
}
