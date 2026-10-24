
import type { MarketPrice } from "../models";

export type YahooRange =
  | "1mo"
  | "3mo"
  | "6mo"
  | "1y"
  | "2y"
  | "5y"
  | "10y"
  | "ytd"
  | "max";

export type YahooInterval = "1d";

export type YahooHistoricalPrice = Omit<
  MarketPrice,
  "id" | "listingId" | "fetchedAt"
>;

interface YahooChartResponse {
  chart?: {
    result?: YahooChartResult[] | null;
    error?: {
      code?: string;
      description?: string;
    } | null;
  };
}

interface YahooChartResult {
  meta?: {
    currency?: string;
    symbol?: string;
    exchangeTimezoneName?: string;
  };
  timestamp?: number[] | null;
  indicators?: {
    quote?: Array<{
      open?: Array<number | null> | null;
      high?: Array<number | null> | null;
      low?: Array<number | null> | null;
      close?: Array<number | null> | null;
      volume?: Array<number | null> | null;
    }>;
    adjclose?: Array<{
      adjclose?: Array<number | null> | null;
    }>;
  };
}

function getMarketDate(
  timestamp: number,
  timeZone: string
): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp * 1000));

  const part = (type: string): string => {
    const value = parts.find((item) => item.type === type)?.value;

    if (!value) {
      throw new Error("Could not determine the market date.");
    }

    return value;
  };

  return `${part("year")}-${part("month")}-${part("day")}`;
}

function validNumber(
  value: number | null | undefined
): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Downloads daily historical prices from Yahoo Finance.
 *
 * This is an unofficial data source. Availability, coverage,
 * rate limits and browser CORS permissions are not guaranteed.
 */
export async function fetchYahooHistoricalPrices(
  symbol: string,
  range: YahooRange = "1y",
  interval: YahooInterval = "1d"
): Promise<YahooHistoricalPrice[]> {
  const normalizedSymbol = symbol.trim().toUpperCase();

  if (!normalizedSymbol) {
    throw new Error("A Yahoo Finance symbol is required.");
  }

  const url = new URL(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      normalizedSymbol
    )}`
  );

  url.searchParams.set("range", range);
  url.searchParams.set("interval", interval);
  url.searchParams.set("events", "div,splits");

  let response: Response;

  try {
    response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      cache: "no-store",
    });
  } catch {
    throw new Error(
      "Could not connect to Yahoo Finance. The request may be blocked by network restrictions or browser CORS permissions."
    );
  }

  if (!response.ok) {
    throw new Error(
      `Yahoo Finance returned HTTP ${response.status} for ${normalizedSymbol}.`
    );
  }

  let payload: YahooChartResponse;

  try {
    payload = (await response.json()) as YahooChartResponse;
  } catch {
    throw new Error(
      `Yahoo Finance returned an invalid response for ${normalizedSymbol}.`
    );
  }

  const chart = payload.chart;

  if (chart?.error) {
    throw new Error(
      chart.error.description ??
        `Yahoo Finance could not retrieve ${normalizedSymbol}.`
    );
  }

  const result = chart?.result?.[0];

  if (!result) {
    throw new Error(
      `No market data was returned for ${normalizedSymbol}. Check the symbol or its availability.`
    );
  }

  const currency = result.meta?.currency?.trim().toUpperCase();

  if (!currency) {
    throw new Error(
      `Yahoo Finance did not provide a quote currency for ${normalizedSymbol}.`
    );
  }

  const timestamps = result.timestamp ?? [];
  const quote = result.indicators?.quote?.[0];

  if (!quote?.close || timestamps.length === 0) {
    throw new Error(
      `No daily closing prices were returned for ${normalizedSymbol}.`
    );
  }

  const timeZone =
    result.meta?.exchangeTimezoneName ?? "UTC";

  const adjustedCloses =
    result.indicators?.adjclose?.[0]?.adjclose;

  const prices: YahooHistoricalPrice[] = [];

  for (let index = 0; index < timestamps.length; index += 1) {
    const timestamp = timestamps[index];
    const close = validNumber(quote.close[index]);

    if (timestamp === undefined || close === undefined) {
      continue;
    }

    const adjustedClose = validNumber(adjustedCloses?.[index]);
    const open = validNumber(quote.open?.[index]);
    const high = validNumber(quote.high?.[index]);
    const low = validNumber(quote.low?.[index]);
    const volume = validNumber(quote.volume?.[index]);

    prices.push({
      date: getMarketDate(timestamp, timeZone),
      provider: "yahoo-finance",
      currency,
      close,
      ...(adjustedClose !== undefined && { adjustedClose }),
      ...(open !== undefined && { open }),
      ...(high !== undefined && { high }),
      ...(low !== undefined && { low }),
      ...(volume !== undefined && { volume }),
    });
  }

  if (prices.length === 0) {
    throw new Error(
      `Yahoo Finance returned no valid closing prices for ${normalizedSymbol}.`
    );
  }

  return prices;
}
