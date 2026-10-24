
import Dexie, { type Table } from "dexie";

import type {
  AppSetting,
  FxRate,
  Instrument,
  InstrumentListing,
  LedgerTransaction,
  MarketDataUpdateLog,
  MarketPrice,
  Portfolio,
  PortfolioPosition,
} from "./models";

class WealthOSDatabase extends Dexie {
  instruments!: Table<Instrument, string>;
  listings!: Table<InstrumentListing, string>;
  marketPrices!: Table<MarketPrice, string>;
  fxRates!: Table<FxRate, string>;
  portfolios!: Table<Portfolio, string>;
  positions!: Table<PortfolioPosition, string>;
  transactions!: Table<LedgerTransaction, string>;
  settings!: Table<AppSetting, string>;
  marketDataLogs!: Table<MarketDataUpdateLog, string>;

  constructor() {
    super("WealthOSDatabase");

    this.version(1).stores({
      instruments:
        "id, isin, name, assetType, status",

      listings:
        "id, instrumentId, symbol, exchange, provider, [provider+symbol], [instrumentId+provider]",

      marketPrices:
        "id, listingId, date, provider, [listingId+date]",

      fxRates:
        "id, baseCurrency, quoteCurrency, date, [baseCurrency+quoteCurrency], [baseCurrency+quoteCurrency+date]",

      portfolios:
        "id, name, baseCurrency",

      positions:
        "id, portfolioId, instrumentId, listingId, [portfolioId+instrumentId]",

      transactions:
        "id, portfolioId, date, type, instrumentId, listingId",

      settings:
        "&key, updatedAt",

      marketDataLogs:
        "id, provider, startedAt, status",
    });
  }
}

export const db = new WealthOSDatabase();

function nowIso(): string {
  return new Date().toISOString();
}

function makeId(prefix: string): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return `${prefix}_${crypto.randomUUID()}`;
  }

  return `${prefix}_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 12)}`;
}

function requireText(
  value: string,
  fieldName: string
): string {
  const normalized = value.trim();

  if (!normalized) {
    throw new Error(`${fieldName} is required.`);
  }

  return normalized;
}

function requirePositiveFinite(
  value: number,
  fieldName: string
): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `${fieldName} must be a positive finite number.`
    );
  }

  return value;
}

function requireValidDate(
  value: string,
  fieldName: string
): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(
      `${fieldName} must use YYYY-MM-DD format.`
    );
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);

  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${fieldName} is not a valid date.`);
  }

  return value;
}

/**
 * Instruments
 */

export async function saveInstrument(
  input: Omit<Instrument, "createdAt" | "updatedAt"> &
    Partial<Pick<Instrument, "createdAt" | "updatedAt">>
): Promise<Instrument> {
  const name = requireText(input.name, "Instrument name");
  const timestamp = nowIso();

  const instrument: Instrument = {
    ...input,
    name,
    isin: input.isin?.trim().toUpperCase() || undefined,
    createdAt: input.createdAt ?? timestamp,
    updatedAt: timestamp,
  };

  await db.instruments.put(instrument);

  return instrument;
}

export async function getInstrument(
  id: string
): Promise<Instrument | undefined> {
  return db.instruments.get(id);
}

export async function searchInstruments(
  query: string,
  limit = 25
): Promise<Instrument[]> {
  const normalized = query.trim();

  if (!normalized) {
    return [];
  }

  const safeLimit = Math.max(
    1,
    Math.min(Math.floor(limit), 100)
  );

  const [byName, byIsin] = await Promise.all([
    db.instruments
      .where("name")
      .startsWithIgnoreCase(normalized)
      .limit(safeLimit)
      .toArray(),

    db.instruments
      .where("isin")
      .equalsIgnoreCase(normalized)
      .limit(safeLimit)
      .toArray(),
  ]);

  const unique = new Map<string, Instrument>();

  for (const instrument of [...byIsin, ...byName]) {
    unique.set(instrument.id, instrument);
  }

  return [...unique.values()].slice(0, safeLimit);
}

/**
 * Listings / market quotations
 */

export async function saveListing(
  input: Omit<InstrumentListing, "createdAt" | "updatedAt"> &
    Partial<Pick<InstrumentListing, "createdAt" | "updatedAt">>
): Promise<InstrumentListing> {
  const instrument = await db.instruments.get(
    input.instrumentId
  );

  if (!instrument) {
    throw new Error(
      `Instrument ${input.instrumentId} does not exist.`
    );
  }

  const symbol = requireText(input.symbol, "Listing symbol");
  const quoteCurrency = requireText(
    input.quoteCurrency,
    "Quote currency"
  ).toUpperCase();

  const timestamp = nowIso();

  const listing: InstrumentListing = {
    ...input,
    symbol,
    quoteCurrency,
    createdAt: input.createdAt ?? timestamp,
    updatedAt: timestamp,
  };

  await db.listings.put(listing);

  return listing;
}

export async function getListingsForInstrument(
  instrumentId: string
): Promise<InstrumentListing[]> {
  return db.listings
    .where("instrumentId")
    .equals(instrumentId)
    .toArray();
}

/**
 * Historical market prices
 *
 * One record per listing, date and provider.
 * Re-importing a record replaces it rather than
 * creating another copy.
 */

export async function saveMarketPrices(
  records: Array<
    Omit<MarketPrice, "id" | "fetchedAt"> &
      Partial<Pick<MarketPrice, "id" | "fetchedAt">>
  >
): Promise<number> {
  if (records.length === 0) {
    return 0;
  }

  const fetchedAt = nowIso();

  const prepared: MarketPrice[] = records.map((record) => {
    const listingId = requireText(
      record.listingId,
      "Listing ID"
    );

    const date = requireValidDate(
      record.date,
      "Market price date"
    );

    const currency = requireText(
      record.currency,
      "Market price currency"
    ).toUpperCase();

    if (
      !Number.isFinite(record.close) ||
      record.close < 0
    ) {
      throw new Error(
        `Invalid closing price for ${listingId} on ${date}.`
      );
    }

    if (
      record.adjustedClose !== undefined &&
      (!Number.isFinite(record.adjustedClose) ||
        record.adjustedClose < 0)
    ) {
      throw new Error(
        `Invalid adjusted closing price for ${listingId} on ${date}.`
      );
    }

    const id =
      record.id ??
      `${listingId}|${date}|${record.provider}`;

    return {
      ...record,
      id,
      listingId,
      date,
      currency,
      fetchedAt: record.fetchedAt ?? fetchedAt,
    };
  });

  await db.marketPrices.bulkPut(prepared);

  return prepared.length;
}

export async function getMarketPrices(
  listingId: string,
  startDate?: string,
  endDate?: string
): Promise<MarketPrice[]> {
  let records = await db.marketPrices
    .where("listingId")
    .equals(listingId)
    .toArray();

  if (startDate) {
    requireValidDate(startDate, "Start date");
    records = records.filter(
      (record) => record.date >= startDate
    );
  }

  if (endDate) {
    requireValidDate(endDate, "End date");
    records = records.filter(
      (record) => record.date <= endDate
    );
  }

  return records.sort((a, b) =>
    a.date.localeCompare(b.date)
  );
}

/**
 * Foreign exchange rates.
 *
 * Convention: rate means
 * 1 unit of baseCurrency = rate units of quoteCurrency.
 */

export async function saveFxRate(
  input: Omit<FxRate, "id" | "fetchedAt"> &
    Partial<Pick<FxRate, "id" | "fetchedAt">>
): Promise<FxRate> {
  const baseCurrency = requireText(
    input.baseCurrency,
    "Base currency"
  ).toUpperCase();

  const quoteCurrency = requireText(
    input.quoteCurrency,
    "Quote currency"
  ).toUpperCase();

  const date = requireValidDate(input.date, "FX date");

  const rate = requirePositiveFinite(input.rate, "FX rate");

  if (baseCurrency === quoteCurrency && rate !== 1) {
    throw new Error(
      "An FX rate from a currency to itself must equal 1."
    );
  }

  const fxRate: FxRate = {
    ...input,
    id:
      input.id ??
      `${baseCurrency}|${quoteCurrency}|${date}|${input.provider}`,
    baseCurrency,
    quoteCurrency,
    date,
    rate,
    fetchedAt: input.fetchedAt ?? nowIso(),
  };

  await db.fxRates.put(fxRate);

  return fxRate;
}

export async function getFxRate(
  baseCurrency: string,
  quoteCurrency: string,
  date: string
): Promise<FxRate | undefined> {
  const base = baseCurrency.trim().toUpperCase();
  const quote = quoteCurrency.trim().toUpperCase();

  requireValidDate(date, "FX date");

  if (base === quote) {
    return {
      id: `${base}|${quote}|${date}|identity`,
      baseCurrency: base,
      quoteCurrency: quote,
      date,
      rate: 1,
      provider: "manual",
      fetchedAt: nowIso(),
    };
  }

  const exact = await db.fxRates
    .where("[baseCurrency+quoteCurrency+date]")
    .equals([base, quote, date])
    .first();

  if (exact) {
    return exact;
  }

  return db.fxRates
    .where("[baseCurrency+quoteCurrency]")
    .equals([base, quote])
    .filter((record) => record.date <= date)
    .last();
}

/**
 * Portfolios and positions
 */

export async function savePortfolio(
  input: Omit<Portfolio, "createdAt" | "updatedAt"> &
    Partial<Pick<Portfolio, "createdAt" | "updatedAt">>
): Promise<Portfolio> {
  const timestamp = nowIso();

  const portfolio: Portfolio = {
    ...input,
    name: requireText(input.name, "Portfolio name"),
    baseCurrency: requireText(
      input.baseCurrency,
      "Portfolio base currency"
    ).toUpperCase(),
    createdAt: input.createdAt ?? timestamp,
    updatedAt: timestamp,
  };

  await db.portfolios.put(portfolio);

  return portfolio;
}

export async function savePosition(
  input: PortfolioPosition
): Promise<PortfolioPosition> {
  if (!Number.isFinite(input.quantity)) {
    throw new Error("Position quantity must be finite.");
  }

  if (input.averageCost !== undefined) {
    if (
      !Number.isFinite(input.averageCost) ||
      input.averageCost < 0
    ) {
      throw new Error(
        "Position average cost must be finite and non-negative."
      );
    }
  }

  const [portfolio, instrument] = await Promise.all([
    db.portfolios.get(input.portfolioId),
    db.instruments.get(input.instrumentId),
  ]);

  if (!portfolio) {
    throw new Error(
      `Portfolio ${input.portfolioId} does not exist.`
    );
  }

  if (!instrument) {
    throw new Error(
      `Instrument ${input.instrumentId} does not exist.`
    );
  }

  if (input.listingId) {
    const listing = await db.listings.get(input.listingId);

    if (!listing || listing.instrumentId !== input.instrumentId) {
      throw new Error(
        "The selected listing does not belong to this instrument."
      );
    }
  }

  const position: PortfolioPosition = {
    ...input,
    updatedAt: nowIso(),
  };

  await db.positions.put(position);

  return position;
}

/**
 * Ledger transactions
 */

export async function saveTransaction(
  input: Omit<LedgerTransaction, "createdAt" | "updatedAt"> &
    Partial<Pick<LedgerTransaction, "createdAt" | "updatedAt">>
): Promise<LedgerTransaction> {
  requireValidDate(input.date, "Transaction date");

  if (!Number.isFinite(input.amount)) {
    throw new Error("Transaction amount must be finite.");
  }

  if (
    input.fee !== undefined &&
    (!Number.isFinite(input.fee) || input.fee < 0)
  ) {
    throw new Error(
      "Transaction fee must be finite and non-negative."
    );
  }

  const portfolio = await db.portfolios.get(input.portfolioId);

  if (!portfolio) {
    throw new Error(
      `Portfolio ${input.portfolioId} does not exist.`
    );
  }

  if (input.instrumentId) {
    const instrument = await db.instruments.get(
      input.instrumentId
    );

    if (!instrument) {
      throw new Error(
        `Instrument ${input.instrumentId} does not exist.`
      );
    }
  }

  const timestamp = nowIso();

  const transaction: LedgerTransaction = {
    ...input,
    currency: requireText(
      input.currency,
      "Transaction currency"
    ).toUpperCase(),
    createdAt: input.createdAt ?? timestamp,
    updatedAt: timestamp,
  };

  await db.transactions.put(transaction);

  return transaction;
}

/**
 * Application settings
 */

export async function saveSetting(
  key: string,
  value: unknown
): Promise<void> {
  await db.settings.put({
    key: requireText(key, "Setting key"),
    value,
    updatedAt: nowIso(),
  });
}

export async function getSetting<T = unknown>(
  key: string
): Promise<T | undefined> {
  const setting = await db.settings.get(key);

  return setting?.value as T | undefined;
}

/**
 * Market data update logs
 */

export async function saveMarketDataLog(
  input: Omit<MarketDataUpdateLog, "id"> &
    Partial<Pick<MarketDataUpdateLog, "id">>
): Promise<MarketDataUpdateLog> {
  const log: MarketDataUpdateLog = {
    ...input,
    id: input.id ?? makeId("market_update"),
  };

  await db.marketDataLogs.put(log);

  return log;
}
