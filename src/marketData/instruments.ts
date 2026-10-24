
export type MarketInstrument = {
    id: string;
    name: string;
    symbol: string;
    isin: string;
    exchange: string;
    quoteCurrency: string;
    fundBaseCurrency: string;
    assetType: "etf" | "stock" | "crypto";
  };
  
  export const MARKET_INSTRUMENTS: MarketInstrument[] = [
    {
      id: "VGWL",
      name: "Vanguard FTSE All-World UCITS ETF USD Distributing",
      symbol: "VGWL.DE",
      isin: "IE00B3RBWM25",
      exchange: "XETRA",
      quoteCurrency: "EUR",
      fundBaseCurrency: "USD",
      assetType: "etf",
    },
    {
      id: "EQQQ",
      name: "Invesco EQQQ Nasdaq-100 UCITS ETF Distributing",
      symbol: "EQQQ.DE",
      isin: "IE0032077012",
      exchange: "XETRA",
      quoteCurrency: "EUR",
      fundBaseCurrency: "USD",
      assetType: "etf",
    },
    {
      id: "LDGL",
      name: "L&G Global Quality Dividends UCITS ETF USD Distributing",
      symbol: "LDGL.DE",
      isin: "IE0005AJA0P1",
      exchange: "XETRA",
      quoteCurrency: "EUR",
      fundBaseCurrency: "USD",
      assetType: "etf",
    },
  ];
  