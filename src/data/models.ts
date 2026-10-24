
export type CurrencyCode = string;

export type AssetType =
  | "stock"
  | "etf"
  | "fund"
  | "bond"
  | "crypto"
  | "commodity"
  | "real_estate"
  | "cash"
  | "private_equity"
  | "other";

export type RecordStatus = "active" | "inactive" | "archived";

export type MarketDataProvider =
  | "yahoo-finance"
  | "manual"
  | "csv-import"
  | "other";

export type TransactionType =
  | "buy"
  | "sell"
  | "dividend"
  | "interest"
  | "deposit"
  | "withdrawal"
  | "fee"
  | "tax"
  | "transfer-in"
  | "transfer-out"
  | "other";

export interface Instrument {
  id: string;
  name: string;
  isin?: string;
  cusip?: string;
  sedol?: string;
  assetType: AssetType;
  baseCurrency?: CurrencyCode;
  countryCode?: string;
  sector?: string;
  status: RecordStatus;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface InstrumentListing {
  id: string;
  instrumentId: string;
  provider: MarketDataProvider;
  symbol: string;
  exchange?: string;
  mic?: string;
  quoteCurrency: CurrencyCode;
  isPrimary: boolean;
  status: RecordStatus;
  lastVerifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MarketPrice {
  id: string;
  listingId: string;
  date: string;
  provider: MarketDataProvider;
  currency: CurrencyCode;
  close: number;
  adjustedClose?: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
  fetchedAt: string;
}

export interface FxRate {
  id: string;
  baseCurrency: CurrencyCode;
  quoteCurrency: CurrencyCode;
  date: string;
  rate: number;
  provider: MarketDataProvider;
  fetchedAt: string;
}

export interface Portfolio {
  id: string;
  name: string;
  baseCurrency: CurrencyCode;
  createdAt: string;
  updatedAt: string;
}

export interface PortfolioPosition {
  id: string;
  portfolioId: string;
  instrumentId: string;
  listingId?: string;
  quantity: number;
  averageCost?: number;
  costCurrency?: CurrencyCode;
  updatedAt: string;
}

export interface LedgerTransaction {
  id: string;
  portfolioId: string;
  instrumentId?: string;
  listingId?: string;
  date: string;
  type: TransactionType;
  quantity?: number;
  price?: number;
  amount: number;
  currency: CurrencyCode;
  fee?: number;
  feeCurrency?: CurrencyCode;
  exchangeRateToPortfolioCurrency?: number;
  description?: string;
  externalReference?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppSetting {
  key: string;
  value: unknown;
  updatedAt: string;
}

export interface MarketDataUpdateLog {
  id: string;
  provider: MarketDataProvider;
  startedAt: string;
  completedAt?: string;
  status: "running" | "success" | "partial" | "failed";
  instrumentsRequested: number;
  instrumentsUpdated: number;
  errorMessage?: string;
}
