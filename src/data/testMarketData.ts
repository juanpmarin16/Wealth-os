
import { fetchYahooHistoricalPrices } from "./providers/yahooFinance";

export async function testMarketDataConnection(): Promise<void> {
  console.log("Starting Yahoo Finance connection test...");

  try {
    const prices = await fetchYahooHistoricalPrices(
      "VGWL.DE",
      "1mo",
      "1d"
    );

    console.log("Connection successful.");
    console.log("Symbol: VGWL.DE");
    console.log("Prices received:", prices.length);
    console.log("Latest price:", prices.at(-1));
  } catch (error) {
    console.error(
      "Yahoo Finance connection test failed:",
      error instanceof Error ? error.message : error
    );
  }
}
