
import {
    saveInstrument,
    saveListing,
    saveMarketPrices,
  } from "./database";
  
  import { fetchYahooHistoricalPrices } from "./providers/yahooFinance";
  
  import type { Instrument, InstrumentListing } from "./models";
  
  export interface MarketDataUpdateResult {
    symbol: string;
    success: boolean;
    pricesSaved: number;
    error?: string;
  }
  
  interface TestInstrument {
    id: string;
    name: string;
    symbol: string;
    isin: string;
    assetType: Instrument["assetType"];
    currency: string;
  }
  
  const TEST_INSTRUMENTS: TestInstrument[] = [
    {
      id: "market-test-vgwl",
      name: "Vanguard FTSE All-World UCITS ETF",
      symbol: "VGWL.DE",
      isin: "IE00B3RBWM25",
      assetType: "etf",
      currency: "EUR",
    },
    {
      id: "market-test-eqqq",
      name: "Invesco EQQQ Nasdaq-100 UCITS ETF",
      symbol: "EQQQ.DE",
      isin: "IE0032077012",
      assetType: "etf",
      currency: "EUR",
    },
    {
      id: "market-test-ldgl",
      name: "L&G Global Quality Dividends UCITS ETF",
      symbol: "LDGL.DE",
      isin: "IE0005AJA0P1",
      assetType: "etf",
      currency: "EUR",
    },
  ];
  
  function getTimestamp(): string {
    return new Date().toISOString();
  }
  
  async function prepareInstrument(
    item: TestInstrument
  ): Promise<string> {
    const now = getTimestamp();
  
    const instrument: Instrument = {
      id: item.id,
      name: item.name,
      isin: item.isin,
      assetType: item.assetType,
      baseCurrency: item.currency,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
  
    const listing: InstrumentListing = {
      id: `yahoo-${item.id}`,
      instrumentId: item.id,
      provider: "yahoo-finance",
      symbol: item.symbol,
      quoteCurrency: item.currency,
      isPrimary: true,
      status: "active",
      lastVerifiedAt: now,
      createdAt: now,
      updatedAt: now,
    };
  
    await saveInstrument(instrument);
    await saveListing(listing);
  
    return listing.id;
  }
  
  /**
   * Updates historical daily prices for the initial test universe.
   *
   * A failed download does not delete previously stored prices.
   * Only valid prices returned by the provider are saved.
   */
  export async function updateTestMarketData(): Promise<
    MarketDataUpdateResult[]
  > {
    const results: MarketDataUpdateResult[] = [];
  
    for (const item of TEST_INSTRUMENTS) {
      try {
        const listingId = await prepareInstrument(item);
  
        const prices = await fetchYahooHistoricalPrices(
          item.symbol,
          "1y",
          "1d"
        );
  
        await saveMarketPrices(
          prices.map((price) => ({
            ...price,
            listingId,
          }))
        );
  
        results.push({
          symbol: item.symbol,
          success: true,
          pricesSaved: prices.length,
        });
      } catch (error) {
        results.push({
          symbol: item.symbol,
          success: false,
          pricesSaved: 0,
          error:
            error instanceof Error
              ? error.message
              : "An unexpected error occurred.",
        });
      }
    }
  
    return results;
  }
  