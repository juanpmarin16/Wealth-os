import { useMemo, useState, type ChangeEvent } from "react";
import { saveInstrument, saveListing, saveMarketPrices } from "./data/database";
import type { AssetType } from "./data/models";

type CsvPrice = {
  date: string;
  open?: number;
  high?: number;
  low?: number;
  close: number;
  volume?: number;
};

const ASSET_TYPES: AssetType[] = [
  "etf", "stock", "fund", "crypto", "bond", "commodity",
  "real_estate", "cash", "private_equity", "other",
];

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
      } else {
        quoted = !quoted;
      }
    } else if (char === delimiter && !quoted) {
      result.push(value.trim());
      value = "";
    } else {
      value += char;
    }
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
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === trimmed
      ? trimmed
      : undefined;
  }

  const match = trimmed.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (match) {
    const [, first, second, year] = match;
    // Stooq typically uses YYYY-MM-DD; this fallback supports DD/MM/YYYY.
    const date = `${year}-${second.padStart(2, "0")}-${first.padStart(2, "0")}`;
    const parsed = new Date(`${date}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date
      ? date
      : undefined;
  }

  return undefined;
}

function parsePriceCsv(text: string): CsvPrice[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error("The CSV file must contain a header and at least one data row.");

  const delimiter = (lines[0].match(/;/g) ?? []).length > (lines[0].match(/,/g) ?? []).length ? ";" : ",";
  const headers = parseCsvLine(lines[0], delimiter).map(normalizeHeader);
  const find = (...names: string[]) => headers.findIndex((header) => names.includes(header));
  const dateIndex = find("date", "datetime");
  const closeIndex = find("close", "closingprice", "price");
  const openIndex = find("open", "openingprice");
  const highIndex = find("high");
  const lowIndex = find("low");
  const volumeIndex = find("volume", "vol");

  if (dateIndex < 0 || closeIndex < 0) {
    throw new Error("Required columns not found. Expected at least Date and Close, such as a Stooq historical CSV.");
  }

  const prices: CsvPrice[] = [];
  const errors: string[] = [];

  for (let i = 1; i < lines.length; i += 1) {
    const cells = parseCsvLine(lines[i], delimiter);
    const date = parseDate(cells[dateIndex] ?? "");
    const close = parseNumeric(cells[closeIndex] ?? "");
    if (!date || close === undefined || close <= 0) {
      errors.push(`Line ${i + 1}: invalid date or closing price.`);
      continue;
    }

    const optional = (index: number) => index < 0 ? undefined : parseNumeric(cells[index] ?? "");
    prices.push({
      date,
      close,
      open: optional(openIndex),
      high: optional(highIndex),
      low: optional(lowIndex),
      volume: optional(volumeIndex),
    });
  }

  if (prices.length === 0) {
    throw new Error(errors[0] ?? "No valid price rows were found in this CSV.");
  }

  const unique = new Map<string, CsvPrice>();
  for (const price of prices) unique.set(price.date, price);
  return [...unique.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function safeId(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "_");
}

export default function MarketDataImport() {
  const [symbol, setSymbol] = useState("VGWL.DE");
  const [instrumentName, setInstrumentName] = useState("Vanguard FTSE All-World UCITS ETF");
  const [assetType, setAssetType] = useState<AssetType>("etf");
  const [currency, setCurrency] = useState("EUR");
  const [exchange, setExchange] = useState("XETRA");
  const [fileName, setFileName] = useState("");
  const [prices, setPrices] = useState<CsvPrice[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  const preview = useMemo(() => prices.slice(-5).reverse(), [prices]);

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
        const parsed = parsePriceCsv(String(reader.result ?? ""));
        setPrices(parsed);
        setMessage(`Loaded ${parsed.length.toLocaleString()} valid daily prices.`);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not parse this CSV file.");
      }
    };
    reader.onerror = () => setError("The selected file could not be read.");
    reader.readAsText(file);
  }

  async function importPrices() {
    setError("");
    setMessage("");
    const normalizedSymbol = symbol.trim().toUpperCase();
    const normalizedCurrency = currency.trim().toUpperCase();

    if (!normalizedSymbol || !instrumentName.trim() || !/^[A-Z]{3}$/.test(normalizedCurrency)) {
      setError("Enter a symbol, instrument name, and a 3-letter currency code.");
      return;
    }
    if (prices.length === 0) {
      setError("Choose and validate a CSV file before importing.");
      return;
    }

    setSaving(true);
    try {
      const instrumentId = `instrument_${safeId(normalizedSymbol)}`;
      const listingId = `listing_csv_${safeId(normalizedSymbol)}`;
      const now = new Date().toISOString();

      await saveInstrument({
        id: instrumentId,
        name: instrumentName.trim(),
        assetType,
        baseCurrency: normalizedCurrency,
        status: "active",
        notes: "Created or updated through CSV historical market data import.",
      });

      await saveListing({
        id: listingId,
        instrumentId,
        provider: "csv-import",
        symbol: normalizedSymbol,
        exchange: exchange.trim() || undefined,
        quoteCurrency: normalizedCurrency,
        isPrimary: true,
        status: "active",
        lastVerifiedAt: now,
      });

      const count = await saveMarketPrices(prices.map((price) => ({
        listingId,
        date: price.date,
        provider: "csv-import" as const,
        currency: normalizedCurrency,
        close: price.close,
        adjustedClose: price.close,
        open: price.open,
        high: price.high,
        low: price.low,
        volume: price.volume,
      })));

      setMessage(`Successfully imported ${count.toLocaleString()} daily prices for ${normalizedSymbol}. Data is saved locally in this browser.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Import failed. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="market-import-page" style={{ display: "grid", gap: 20 }}>
      <section className="panel" style={{ padding: 22 }}>
        <h2 style={{ marginTop: 0 }}>Import Historical Market Data</h2>
        <p style={{ color: "var(--muted)", lineHeight: 1.7 }}>
          Import a historical price CSV downloaded from Stooq or another provider. The file is processed in your browser and stored in Wealth OS local IndexedDB; no upload to a server is required.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
          <label>
            Instrument symbol
            <input value={symbol} onChange={(event) => setSymbol(event.target.value)} placeholder="VGWL.DE" />
          </label>
          <label>
            Instrument name
            <input value={instrumentName} onChange={(event) => setInstrumentName(event.target.value)} placeholder="ETF name" />
          </label>
          <label>
            Asset type
            <select value={assetType} onChange={(event) => setAssetType(event.target.value as AssetType)}>
              {ASSET_TYPES.map((type) => <option key={type} value={type}>{type.replace("_", " ")}</option>)}
            </select>
          </label>
          <label>
            Quote currency
            <input value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} maxLength={3} placeholder="EUR" />
          </label>
          <label>
            Exchange (optional)
            <input value={exchange} onChange={(event) => setExchange(event.target.value)} placeholder="XETRA" />
          </label>
        </div>

        <label style={{ display: "block", marginTop: 18 }}>
          Historical CSV file
          <input type="file" accept=".csv,text/csv,text/plain" onChange={handleFile} style={{ display: "block", marginTop: 8, width: "100%" }} />
        </label>
        {fileName && <p style={{ color: "var(--muted)", fontSize: 13 }}>Selected file: {fileName}</p>}

        {error && <div role="alert" style={{ marginTop: 14, padding: 12, borderRadius: 8, background: "rgba(231,121,105,.12)", color: "#e77969" }}>{error}</div>}
        {message && <div role="status" style={{ marginTop: 14, padding: 12, borderRadius: 8, background: "rgba(54,201,165,.12)", color: "#36c9a5" }}>{message}</div>}

        <button className="primary-button" onClick={importPrices} disabled={saving || prices.length === 0} style={{ marginTop: 18 }}>
          {saving ? "Importing..." : `Import ${prices.length ? prices.length.toLocaleString() + " prices" : "CSV prices"}`}
        </button>
      </section>

      {prices.length > 0 && (
        <section className="panel" style={{ padding: 22 }}>
          <h3 style={{ marginTop: 0 }}>Import Preview</h3>
          <p style={{ color: "var(--muted)", fontSize: 13 }}>
            {prices.length.toLocaleString()} daily records · {prices[0].date} to {prices[prices.length - 1].date}
          </p>
          <div className="table-scroll">
            <table className="holdings-table">
              <thead><tr><th>DATE</th><th>OPEN</th><th>HIGH</th><th>LOW</th><th>CLOSE</th><th>VOLUME</th></tr></thead>
              <tbody>
                {preview.map((price) => (
                  <tr key={price.date}>
                    <td>{price.date}</td>
                    <td>{price.open ?? "—"}</td>
                    <td>{price.high ?? "—"}</td>
                    <td>{price.low ?? "—"}</td>
                    <td><strong>{price.close}</strong></td>
                    <td>{price.volume?.toLocaleString() ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ color: "var(--muted)", fontSize: 12, lineHeight: 1.6 }}>
            Preview shows the five most recent dates. Re-importing the same symbol and date replaces that provider's existing record rather than creating duplicate rows.
          </p>
        </section>
      )}
    </div>
  );
}
