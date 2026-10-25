
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import Analytics from './Analytics';
import MarketDataImport from './MarketDataImport';
import './App.css';

type Asset = {
  id: string;
  name: string;
  ticker: string;
  category: string;
  openingValue: number;
  quantity: number;
  currentPrice: number;
  openingPrice?: number;
  averageCost: number;
};

type TransactionType =
  | 'Buy'
  | 'Sell'
  | 'Dividend'
  | 'Deposit'
  | 'Withdrawal'
  | 'Fee';

type Transaction = {
  id: string;
  date: string;
  type: TransactionType;
  ticker: string;
  amount: number;
  quantity: number;
  price: number;
  fee: number;
  notes: string;
  realizedGain: number;
};

type StoredTransaction = Omit<Transaction, 'realizedGain'> & {
  realizedGain?: number;
};

type LedgerResult = {
  assets: Asset[];
  openingCash: number;
  transactions: Transaction[];
};

const ASSETS_KEY = 'wealth-os-assets';
const TRANSACTIONS_KEY = 'wealth-os-transactions';
const CASH_KEY = 'wealth-os-opening-cash';
const VERSION_KEY = 'wealth-os-accounting-version';
const OPENING_DATE_KEY = 'wealth-os-opening-date';
const PORTFOLIO_API_URL = 'https://wealth-os-market-data.onrender.com';

const DEMO_ASSETS: Asset[] = [
  { id: '1', name: 'Global Equity ETF', ticker: 'VGWL', category: 'Equities', openingValue: 112400, quantity: 0, currentPrice: 0, averageCost: 0 },
  { id: '2', name: 'Nasdaq 100 ETF', ticker: 'EQQQ', category: 'Equities', openingValue: 44800, quantity: 0, currentPrice: 0, averageCost: 0 },
  { id: '3', name: 'Bitcoin', ticker: 'BTC', category: 'Crypto', openingValue: 36400, quantity: 0, currentPrice: 0, averageCost: 0 },
  { id: '4', name: 'Gold', ticker: 'LDGL', category: 'Commodities', openingValue: 22400, quantity: 0, currentPrice: 0, averageCost: 0 },
  { id: '5', name: 'Other Investments', ticker: 'OTHER', category: 'Other', openingValue: 36400, quantity: 0, currentPrice: 0, averageCost: 0 },
];

const DEMO_CASH = 28000;

const TRANSACTION_TYPES: TransactionType[] = [
  'Buy',
  'Sell',
  'Dividend',
  'Deposit',
  'Withdrawal',
  'Fee',
];

const CATEGORIES = [
  'Equities',
  'Bonds',
  'Crypto',
  'Commodities',
  'Real Estate',
  'Cash',
  'Other',
];

const money = (value: number) =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 2,
  }).format(value);

const shortMoney = (value: number) =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 0,
  }).format(value);

const numberFormat = (value: number, digits = 6) =>
  new Intl.NumberFormat('en-GB', {
    maximumFractionDigits: digits,
  }).format(value);

function today() {
  const now = new Date();
  return new Date(
    now.getTime() - now.getTimezoneOffset() * 60000
  ).toISOString().slice(0, 10);
}

function previousDay(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

function id() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function validNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStoredTransaction(value: unknown): value is StoredTransaction {
  if (!isRecord(value)) return false;

  return (
    typeof value.id === 'string' &&
    typeof value.date === 'string' &&
    typeof value.type === 'string' &&
    TRANSACTION_TYPES.includes(value.type as TransactionType) &&
    typeof value.ticker === 'string' &&
    validNumber(value.amount) &&
    validNumber(value.quantity) &&
    validNumber(value.price) &&
    validNumber(value.fee) &&
    typeof value.notes === 'string' &&
    (value.realizedGain === undefined || validNumber(value.realizedGain))
  );
}

function readStoredAssets(): unknown[] | null {
  try {
    const raw = localStorage.getItem(ASSETS_KEY);
    if (raw === null) return null;

    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function readOpeningCash(): number {
  try {
    const explicit = localStorage.getItem(CASH_KEY);

    if (explicit !== null) {
      const value = Number(explicit);
      if (Number.isFinite(value) && value >= 0) return value;
    }

    const oldAssets = readStoredAssets();
    const oldCash = oldAssets?.find(
      (item) =>
        isRecord(item) &&
        'ticker' in item &&
        String(item.ticker).toUpperCase() === 'EUR'
    );

    if (
      isRecord(oldCash) &&
      'value' in oldCash &&
      validNumber(oldCash.value) &&
      oldCash.value >= 0
    ) {
      return oldCash.value;
    }
  } catch {
    // Fall back to demo opening cash.
  }

  return DEMO_CASH;
}

function readTransactions(): Transaction[] {
  try {
    const raw = localStorage.getItem(TRANSACTIONS_KEY);
    if (raw === null) return [];

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(isStoredTransaction)
      .map((item) => ({
        id: item.id,
        date: item.date,
        type: item.type,
        ticker: item.ticker.toUpperCase(),
        amount: item.amount,
        quantity: item.quantity,
        price: item.price,
        fee: item.fee,
        notes: item.notes,
        realizedGain: validNumber(item.realizedGain)
          ? item.realizedGain
          : 0,
      }));
  } catch {
    return [];
  }
}

/**
 * The performance period starts one day before the
 * earliest valid recorded transaction.
 */
function deriveOpeningDate(transactions: Transaction[]): string {
  const dates = transactions
    .map((tx) => tx.date)
    .filter(
      (date) =>
        /^\d{4}-\d{2}-\d{2}$/.test(date) &&
        date <= today() &&
        !Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())
    )
    .sort();

  return dates.length > 0 ? previousDay(dates[0]) : '';
}

function readOpeningDate(): string {
  // Derive the date from the existing local ledger so that
  // older saved data remains compatible.
  return deriveOpeningDate(readTransactions());
}

function readAssets(): Asset[] {
  const stored = readStoredAssets();

  if (stored === null) {
    return DEMO_ASSETS;
  }

  return stored
    .filter(
      (item): item is Record<string, unknown> =>
        isRecord(item) &&
        typeof item.id === 'string' &&
        typeof item.name === 'string' &&
        typeof item.ticker === 'string' &&
        typeof item.category === 'string'
    )
    .filter((item) => String(item.ticker).toUpperCase() !== 'EUR')
    .map((item) => {
      const old = item;

      const openingValue = validNumber(old.openingValue)
        ? old.openingValue
        : validNumber(old.value)
          ? old.value
          : 0;

      return {
        id: String(old.id),
        name: String(old.name),
        ticker: String(old.ticker).trim().toUpperCase(),
        category: String(old.category),
        openingValue: Math.max(0, openingValue),
        quantity:
          validNumber(old.quantity) && old.quantity >= 0
            ? old.quantity
            : 0,
        currentPrice:
          validNumber(old.currentPrice) && old.currentPrice >= 0
            ? old.currentPrice
            : 0,
        openingPrice:
          validNumber(old.openingPrice) && old.openingPrice > 0
            ? old.openingPrice
            : undefined,
        averageCost:
          validNumber(old.averageCost) && old.averageCost >= 0
            ? old.averageCost
            : 0,
      };
    });
}

function calculateLedger(
  initialAssets: Asset[],
  transactions: Transaction[],
  openingCash: number
): LedgerResult {
  const assets = initialAssets.map((asset) => ({ ...asset }));

  const ordered = [...transactions].sort(
    (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)
  );

  for (const tx of ordered) {
    const ticker = tx.ticker.toUpperCase();
    const asset = assets.find((item) => item.ticker === ticker);

    switch (tx.type) {
      case 'Buy': {
        if (!asset) break;

        const oldQuantity = asset.quantity;
        const newQuantity = oldQuantity + tx.quantity;

        asset.averageCost =
          newQuantity > 0
            ? (
                oldQuantity * asset.averageCost +
                tx.quantity * tx.price
              ) / newQuantity
            : 0;

        asset.quantity = newQuantity;
        asset.currentPrice = tx.price;
        break;
      }

      case 'Sell': {
        if (!asset || tx.quantity > asset.quantity + 1e-8) break;

        const quantitySold = Math.min(tx.quantity, asset.quantity);
        asset.quantity = Math.max(0, asset.quantity - quantitySold);
        asset.currentPrice = tx.price;

        if (asset.quantity < 1e-8) {
          asset.quantity = 0;
          asset.averageCost = 0;
        }
        break;
      }

      case 'Dividend':
      case 'Deposit':
      case 'Withdrawal':
      case 'Fee':
        break;
    }
  }

  return {
    assets,
    openingCash,
    transactions: ordered,
  };
}

function App() {
  const [initialAssets, setInitialAssets] = useState<Asset[]>(readAssets);
  const [transactions, setTransactions] =
    useState<Transaction[]>(readTransactions);
  const [openingCash, setOpeningCash] = useState<number>(readOpeningCash);

  const [openingDate, setOpeningDate] =
    useState<string>(readOpeningDate);

  const [page, setPage] = useState('Dashboard');
  const [showAssetForm, setShowAssetForm] = useState(false);
  const [showTransactionForm, setShowTransactionForm] = useState(false);
  const [editingTransactionId, setEditingTransactionId] = useState<string | null>(null);
  const [editingAssetId, setEditingAssetId] = useState<string | null>(null);
  const [assetSearch, setAssetSearch] = useState('');
  const [transactionSearch, setTransactionSearch] = useState('');
  const [transactionTypeFilter, setTransactionTypeFilter] = useState('All');
  const [notice, setNotice] = useState('');

  const [assetForm, setAssetForm] = useState({
    name: '',
    ticker: '',
    category: 'Equities',
    openingValue: '0',
    quantity: '0',
    currentPrice: '0',
  });

  const [txForm, setTxForm] = useState({
    date: today(),
    type: 'Buy' as TransactionType,
    ticker: '',
    amount: '',
    quantity: '',
    price: '',
    fee: '0',
    notes: '',
  });

  const [accessToken, setAccessToken] = useState<string>(() => {
    try { return sessionStorage.getItem('wealth-os-session-token') ?? ''; } catch { return ''; }
  });
  const [accessPassword, setAccessPassword] = useState('');
  const [accessStatus, setAccessStatus] = useState<'signedOut' | 'checking' | 'signedIn'>(
    () => {
      try { return sessionStorage.getItem('wealth-os-session-token') ? 'checking' : 'signedOut'; }
      catch { return 'signedOut'; }
    },
  );
  const [accessError, setAccessError] = useState('');
  const [cloudLoaded, setCloudLoaded] = useState(false);
  const skipFirstCloudSave = useRef(true);

  async function hydrateCloudPortfolio(token: string) {
    setAccessError('');
    try {
      const response = await fetch(`${PORTFOLIO_API_URL}/api/portfolio`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      const result: unknown = await response.json().catch(() => null);
      if (response.status === 401) throw new Error('Your session expired. Please sign in again.');
      if (!response.ok) {
        const detail = typeof result === 'object' && result !== null && 'detail' in result
          ? String(result.detail) : `Portfolio API returned HTTP ${response.status}.`;
        throw new Error(detail);
      }
      if (!isRecord(result)) throw new Error('The portfolio API returned an invalid response.');
      if (result.exists === true && isRecord(result.portfolio)) {
        const portfolio = result.portfolio;
        if (Array.isArray(portfolio.assets)) {
          setInitialAssets(portfolio.assets.filter((item): item is Asset =>
            isRecord(item) && typeof item.id === 'string' && typeof item.name === 'string' &&
            typeof item.ticker === 'string' && typeof item.category === 'string' &&
            validNumber(item.openingValue) && validNumber(item.quantity) &&
            validNumber(item.currentPrice) && validNumber(item.averageCost),
          ));
        }
        if (Array.isArray(portfolio.transactions)) {
          setTransactions(portfolio.transactions.filter(isStoredTransaction).map((item) => ({
            id: item.id, date: item.date, type: item.type, ticker: item.ticker.toUpperCase(),
            amount: item.amount, quantity: item.quantity, price: item.price, fee: item.fee,
            notes: item.notes, realizedGain: validNumber(item.realizedGain) ? item.realizedGain : 0,
          })));
        }
        if (validNumber(portfolio.openingCash) && portfolio.openingCash >= 0) setOpeningCash(portfolio.openingCash);
        if (typeof portfolio.openingDate === 'string') setOpeningDate(portfolio.openingDate);
      } else {
        // First sign-in: migrate this browser's existing portfolio to the shared cloud account.
        const localPortfolio = {
          assets: initialAssets,
          transactions,
          openingCash,
          openingDate,
        };
        const saveResponse = await fetch(`${PORTFOLIO_API_URL}/api/portfolio`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(localPortfolio),
        });
        if (!saveResponse.ok) {
          const payload: unknown = await saveResponse.json().catch(() => null);
          const detail = isRecord(payload) && 'detail' in payload ? String(payload.detail) : 'Could not migrate this browser portfolio.';
          throw new Error(detail);
        }
      }
      setAccessToken(token);
      setAccessStatus('signedIn');
      setCloudLoaded(true);
    } catch (cause) {
      setAccessStatus('signedOut');
      setCloudLoaded(false);
      try { sessionStorage.removeItem('wealth-os-session-token'); } catch { /* Ignore unavailable storage. */ }
      setAccessToken('');
      setAccessError(cause instanceof Error ? cause.message : 'Could not connect to cloud portfolio storage.');
    }
  }

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAccessError('');
    setAccessStatus('checking');
    try {
      const response = await fetch(`${PORTFOLIO_API_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ password: accessPassword }),
      });
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok || !isRecord(result) || typeof result.token !== 'string') {
        const detail = isRecord(result) && 'detail' in result ? String(result.detail) : 'Sign-in failed.';
        throw new Error(detail);
      }
      try { sessionStorage.setItem('wealth-os-session-token', result.token); } catch { /* Session can remain in memory. */ }
      setAccessPassword('');
      await hydrateCloudPortfolio(result.token);
    } catch (cause) {
      setAccessStatus('signedOut');
      setAccessError(cause instanceof Error ? cause.message : 'Sign-in failed.');
    }
  }

  function signOut() {
    try { sessionStorage.removeItem('wealth-os-session-token'); } catch { /* Ignore unavailable storage. */ }
    setAccessToken('');
    setAccessStatus('signedOut');
    setCloudLoaded(false);
    setAccessError('');
  }

  useEffect(() => {
    if (accessToken && accessStatus === 'checking') void hydrateCloudPortfolio(accessToken);
    // Validate a session token once on page load; sign-in calls hydration directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ledger = useMemo(
    () => calculateLedger(initialAssets, transactions, openingCash),
    [initialAssets, transactions, openingCash]
  );

  const valuedAssets = useMemo(
    () =>
      ledger.assets.map((asset) => ({
        ...asset,
        value: (asset.openingValue > 0 && asset.currentPrice > 0 && asset.openingPrice && asset.openingPrice > 0
          ? asset.openingValue * (asset.currentPrice / asset.openingPrice)
          : asset.openingValue) + asset.quantity * asset.currentPrice,
      })),
    [ledger.assets]
  );

  const cashBalance = useMemo(() => {
    let balance = openingCash;

    const ordered = [...transactions].sort(
      (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)
    );

    for (const tx of ordered) {
      switch (tx.type) {
        case 'Buy':
          balance -= tx.amount + tx.fee;
          break;
        case 'Sell':
        case 'Dividend':
        case 'Deposit':
          balance += tx.amount - tx.fee;
          break;
        case 'Withdrawal':
        case 'Fee':
          balance -= tx.amount + tx.fee;
          break;
      }
    }

    return balance;
  }, [openingCash, transactions]);

  const totalAssets = valuedAssets.reduce(
    (sum, asset) => sum + asset.value,
    0
  );

  const totalNetWorth = totalAssets + cashBalance;
  const investedAssets = totalAssets;

  const totalDividends = transactions
    .filter((tx) => tx.type === 'Dividend')
    .reduce((sum, tx) => sum + tx.amount - tx.fee, 0);

  const totalFees = transactions.reduce(
    (sum, tx) => sum + tx.fee + (tx.type === 'Fee' ? tx.amount : 0),
    0
  );

  const realizedGain = transactions.reduce(
    (sum, tx) => sum + tx.realizedGain,
    0
  );

  const allocation = valuedAssets.reduce<Record<string, number>>(
    (result, asset) => {
      result[asset.category] =
        (result[asset.category] || 0) + asset.value;
      return result;
    },
    {}
  );

  allocation.Cash = cashBalance;

  const filteredAssets = valuedAssets.filter((asset) =>
    `${asset.name} ${asset.ticker} ${asset.category}`
      .toLowerCase()
      .includes(assetSearch.toLowerCase())
  );

  const filteredTransactions = [...transactions]
    .filter((tx) => {
      const matchesSearch =
        `${tx.ticker} ${tx.type} ${tx.notes}`
          .toLowerCase()
          .includes(transactionSearch.toLowerCase());

      const matchesType =
        transactionTypeFilter === 'All' ||
        tx.type === transactionTypeFilter;

      return matchesSearch && matchesType;
    })
    .sort(
      (a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)
    );

  useEffect(() => {
    try {
      localStorage.setItem(ASSETS_KEY, JSON.stringify(initialAssets));
      localStorage.setItem(CASH_KEY, String(openingCash));
      localStorage.setItem(VERSION_KEY, '2');
    } catch {
      setNotice('Warning: your browser could not save portfolio data.');
    }
  }, [initialAssets, openingCash]);

  useEffect(() => {
    try {
      localStorage.setItem(
        TRANSACTIONS_KEY,
        JSON.stringify(transactions)
      );

      // Keep the performance start date synchronized with
      // the earliest transaction, including after deletions.
      const derivedDate = deriveOpeningDate(transactions);

      setOpeningDate((current) =>
        current === derivedDate ? current : derivedDate
      );
    } catch {
      setNotice('Warning: your browser could not save transaction data.');
    }
  }, [transactions]);

  useEffect(() => {
    try {
      if (openingDate) {
        localStorage.setItem(OPENING_DATE_KEY, openingDate);
      } else {
        localStorage.removeItem(OPENING_DATE_KEY);
      }
    } catch {
      setNotice('Warning: your browser could not save the performance start date.');
    }
  }, [openingDate]);

  useEffect(() => {
    if (!cloudLoaded || !accessToken) return;
    if (skipFirstCloudSave.current) {
      skipFirstCloudSave.current = false;
      return;
    }
    const timeout = window.setTimeout(async () => {
      try {
        const response = await fetch(`${PORTFOLIO_API_URL}/api/portfolio`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ assets: initialAssets, transactions, openingCash, openingDate }),
        });
        if (response.status === 401) {
          signOut();
          setAccessError('Your session expired. Please sign in again.');
          return;
        }
        if (!response.ok) {
          const payload: unknown = await response.json().catch(() => null);
          const detail = isRecord(payload) && 'detail' in payload ? String(payload.detail) : `Cloud save failed (HTTP ${response.status}).`;
          setNotice(detail);
        }
      } catch {
        setNotice('Cloud save failed. Check your connection; local browser data is still available.');
      }
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [cloudLoaded, accessToken, initialAssets, transactions, openingCash, openingDate]);

  if (accessStatus !== 'signedIn' || !cloudLoaded) {
    return (
      <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: 'var(--background, #0b1020)' }}>
        <section className="panel" style={{ width: '100%', maxWidth: 440, padding: 28 }}>
          <h1 style={{ marginTop: 0 }}>Wealth OS</h1>
          <p style={{ color: 'var(--muted)', lineHeight: 1.7 }}>
            Sign in to securely access your shared portfolio. Your holdings and transactions are stored in the cloud and synchronized across browsers.
          </p>
          {accessStatus === 'checking' ? (
            <p role="status">Connecting to your cloud portfolio…</p>
          ) : (
            <form onSubmit={signIn} style={{ display: 'grid', gap: 14 }}>
              <label htmlFor="wealth-os-password">Portfolio password</label>
              <input
                id="wealth-os-password"
                type="password"
                autoComplete="current-password"
                value={accessPassword}
                onChange={(event) => setAccessPassword(event.target.value)}
                required
                minLength={12}
                placeholder="Enter your shared password"
                style={{ width: '100%', boxSizing: 'border-box' }}
              />
              <button className="primary-button" type="submit">Sign in</button>
            </form>
          )}
          {accessError && <p role="alert" style={{ color: '#e77969', whiteSpace: 'pre-wrap' }}>{accessError}</p>}
        </section>
      </main>
    );
  }

  function openAddAsset() {
    setEditingAssetId(null);
    setAssetForm({
      name: '',
      ticker: '',
      category: 'Equities',
      openingValue: '0',
      quantity: '0',
      currentPrice: '0',
    });
    setShowAssetForm(true);
  }

  function openEditAsset(asset: Asset) {
    setEditingAssetId(asset.id);
    setAssetForm({
      name: asset.name,
      ticker: asset.ticker,
      category: asset.category,
      openingValue: String(asset.openingValue),
      quantity: String(asset.quantity),
      currentPrice: String(asset.currentPrice),
    });
    setShowAssetForm(true);
  }

  function saveAsset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const ticker = assetForm.ticker.trim().toUpperCase();
    const openingValue = Number(assetForm.openingValue);
    const quantity = Number(assetForm.quantity);
    const currentPrice = Number(assetForm.currentPrice);

    if (
      !assetForm.name.trim() ||
      !ticker ||
      ticker === 'EUR' ||
      !Number.isFinite(openingValue) ||
      openingValue < 0 ||
      !Number.isFinite(quantity) ||
      quantity < 0 ||
      !Number.isFinite(currentPrice) ||
      currentPrice < 0
    ) {
      setNotice(
        'Please enter valid asset details. Use the Cash section for EUR cash.'
      );
      return;
    }

    const tickerInUse = initialAssets.some(
      (asset) =>
        asset.ticker === ticker && asset.id !== editingAssetId
    );

    if (tickerInUse) {
      setNotice(`An asset with ticker ${ticker} already exists.`);
      return;
    }

    const existing = editingAssetId
      ? initialAssets.find((asset) => asset.id === editingAssetId)
      : undefined;

    const nextAsset: Asset = {
      id: editingAssetId || id(),
      name: assetForm.name.trim(),
      ticker,
      category: assetForm.category,
      openingValue,
      quantity,
      currentPrice,
      averageCost: existing?.averageCost ?? currentPrice,
    };

    setInitialAssets((current) =>
      editingAssetId
        ? current.map((asset) =>
            asset.id === editingAssetId ? nextAsset : asset
          )
        : [...current, nextAsset]
    );

    setShowAssetForm(false);
    setNotice('Asset saved. Portfolio values have been recalculated.');
  }

  function deleteAsset(asset: Asset) {
    const hasTransactions = transactions.some(
      (tx) =>
        tx.ticker === asset.ticker &&
        (tx.type === 'Buy' || tx.type === 'Sell')
    );

    const message = hasTransactions
      ? `${asset.ticker} has recorded trades. Deleting it will prevent those trades from appearing in asset valuation. Continue?`
      : `Delete ${asset.name} from your portfolio?`;

    if (!window.confirm(message)) return;

    setInitialAssets((current) =>
      current.filter((item) => item.id !== asset.id)
    );

    setNotice(`${asset.ticker} removed from the asset list.`);
  }

  function openAddTransaction() {
    setEditingTransactionId(null);

    setTxForm({
      date: today(),
      type: 'Buy',
      ticker: '',
      amount: '',
      quantity: '',
      price: '',
      fee: '0',
      notes: '',
    });

    setShowTransactionForm(true);
  }

  function saveTransaction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const type = txForm.type;
    const ticker = txForm.ticker.trim().toUpperCase();
    const amount = Number(txForm.amount);
    const quantity = Number(txForm.quantity || 0);
    const price = Number(txForm.price || 0);
    const fee = Number(txForm.fee || 0);

    if (
      !txForm.date ||
      txForm.amount.trim() === '' ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      !Number.isFinite(quantity) ||
      quantity < 0 ||
      !Number.isFinite(price) ||
      price < 0 ||
      !Number.isFinite(fee) ||
      fee < 0
    ) {
      setNotice(
        'Please complete the required fields with valid positive amounts.'
      );
      return;
    }

    if (
      ['Buy', 'Sell', 'Dividend'].includes(type) &&
      !ticker
    ) {
      setNotice('Please enter the asset ticker.');
      return;
    }

    if (
      ['Buy', 'Sell'].includes(type) &&
      (quantity <= 0 || price <= 0)
    ) {
      setNotice('Trades require a positive quantity and unit price.');
      return;
    }

    if (
      ['Buy', 'Sell'].includes(type) &&
      Math.abs(quantity * price - amount) >
        Math.max(0.02, amount * 0.002)
    ) {
      setNotice(
        `Trade amount should match quantity × unit price. Expected approximately ${money(quantity * price)}.`
      );
      return;
    }

    if (
      ['Buy', 'Sell', 'Dividend'].includes(type) &&
      !initialAssets.some((asset) => asset.ticker === ticker)
    ) {
      setNotice(
        `Add ${ticker} to My Portfolio before recording this transaction.`
      );
      return;
    }

    if (type === 'Buy' && cashBalance < amount + fee) {
      setNotice(
        `Insufficient cash. Available: ${money(cashBalance)}; required: ${money(amount + fee)}.`
      );
      return;
    }

    if (type === 'Sell') {
      const asset = ledger.assets.find((item) => item.ticker === ticker);

      if (!asset || quantity > asset.quantity + 1e-8) {
        setNotice(
          `Insufficient tracked units to sell ${ticker}. Available tracked quantity: ${numberFormat(asset?.quantity ?? 0)}. Convert any legacy opening balance into tracked units first if applicable.`
        );
        return;
      }

      if (amount < fee) {
        setNotice(
          'The sale proceeds cannot be lower than the transaction fee.'
        );
        return;
      }
    }

    if (
      ['Dividend', 'Deposit', 'Sell'].includes(type) &&
      cashBalance + amount - fee < -0.000001
    ) {
      setNotice('This transaction would create a negative cash balance.');
      return;
    }

    if (
      ['Withdrawal', 'Fee'].includes(type) &&
      cashBalance < amount + fee
    ) {
      setNotice(`Insufficient cash. Available: ${money(cashBalance)}.`);
      return;
    }

    let gain = 0;

    if (type === 'Sell') {
      const asset = ledger.assets.find((item) => item.ticker === ticker);
      gain = amount - quantity * (asset?.averageCost ?? 0) - fee;
    }

    const tx: Transaction = {
      id: editingTransactionId || id(),
      date: txForm.date,
      type,
      ticker: ticker || 'EUR',
      amount,
      quantity: ['Buy', 'Sell'].includes(type) ? quantity : 0,
      price: ['Buy', 'Sell'].includes(type) ? price : 0,
      fee,
      notes: txForm.notes.trim(),
      realizedGain: gain,
    };

    setTransactions((current) =>
      editingTransactionId
        ? current.map((item) =>
            item.id === editingTransactionId ? tx : item
          )
        : [...current, tx]
    );

    setEditingTransactionId(null);
    setShowTransactionForm(false);
    setNotice(
      `${type} transaction saved. Cash and holdings have been recalculated.`
    );
  }

  function openEditTransaction(tx: Transaction) {
    setEditingTransactionId(tx.id);

    setTxForm({
      date: tx.date,
      type: tx.type,
      ticker: tx.ticker === 'EUR' ? '' : tx.ticker,
      amount: String(tx.amount),
      quantity: tx.quantity ? String(tx.quantity) : '',
      price: tx.price ? String(tx.price) : '',
      fee: String(tx.fee),
      notes: tx.notes,
    });

    setShowTransactionForm(true);
  }

  function deleteTransaction(tx: Transaction) {
    if (
      !window.confirm(
        `Delete the ${tx.type} transaction dated ${tx.date}? Portfolio balances will be recalculated.`
      )
    ) {
      return;
    }

    setTransactions((current) =>
      current.filter((item) => item.id !== tx.id)
    );

    setNotice(
      'Transaction deleted. Portfolio balances have been recalculated.'
    );
  }

  function resetDemo() {
    if (
      !window.confirm(
        'Reset all portfolio assets, opening cash and transaction history to the demo state? This cannot be undone.'
      )
    ) {
      return;
    }

    setInitialAssets(DEMO_ASSETS);
    setOpeningCash(DEMO_CASH);
    setTransactions([]);
    setOpeningDate('');
    setNotice('Demo portfolio restored.');
  }

  function editOpeningCash() {
    const value = window.prompt(
      'Enter your opening cash balance in EUR. This is the cash balance before all recorded transactions.',
      String(openingCash)
    );

    if (value === null) return;

    const parsed = Number(value);

    if (!Number.isFinite(parsed) || parsed < 0) {
      setNotice('Enter a valid non-negative cash balance.');
      return;
    }

    setOpeningCash(parsed);
    setNotice('Opening cash balance updated.');
  }

  const navItems = [
    { label: 'Dashboard', icon: '◫' },
    { label: 'My Portfolio', icon: '▤' },
    { label: 'Transactions', icon: '⇄' },
    { label: 'Analytics', icon: '▥' },
    { label: 'Simulator', icon: '⌁' },
    { label: 'Market Data', icon: '↧' },
  ];

  const colors = [
    '#7c8cff',
    '#36c9a5',
    '#f4b860',
    '#df79b7',
    '#5cb7e8',
    '#a0a8ba',
    '#e77969',
  ];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">W</div>
          <div>
            <strong>WEALTH OS</strong>
            <small>Personal Wealth Platform</small>
          </div>
        </div>

        <div className="nav-label">WORKSPACE</div>

        <nav className="navigation">
          {navItems.map((item) => (
            <button
              key={item.label}
              className={`nav-item ${page === item.label ? 'active' : ''}`}
              onClick={() => {
                setPage(item.label);
                setShowAssetForm(false);
                setShowTransactionForm(false);
              }}
            >
              <span className="nav-icon">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="local-status">
            <span className="status-dot" />
            <div>
              <strong>Local mode</strong>
              <small>Stored in this browser</small>
            </div>
          </div>
          <small className="version-label">WEALTH OS · ACCOUNTING V2</small>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <div className="breadcrumb">WEALTH / {page.toUpperCase()}</div>
            <h1>{page}</h1>
          </div>

          <div className="topbar-right">
            <span className="demo-badge">Local data</span>
            <div className="avatar">W</div>
          </div>
        </header>

        {notice && (
          <div
            className="panel"
            role="status"
            style={{
              marginTop: 16,
              padding: '12px 16px',
              color: '#bdeedf',
              fontSize: 12,
              lineHeight: 1.6,
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 12,
              }}
            >
              <span>{notice}</span>
              <button
                className="text-button"
                onClick={() => setNotice('')}
                aria-label="Dismiss message"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {page === 'Dashboard' && (
          <>
            <section className="welcome-row">
              <div>
                <h2>Your financial overview</h2>
                <p>
                  Portfolio values are calculated from opening balances and
                  recorded trades.
                </p>
              </div>

              <button
                className="primary-button"
                onClick={openAddTransaction}
              >
                + Add transaction
              </button>
            </section>

            <section className="metrics">
              <div className="metric-card">
                <span className="metric-label">TOTAL NET WORTH</span>
                <strong className="metric-value">
                  {shortMoney(totalNetWorth)}
                </strong>
                <span className="metric-note">
                  Assets plus current cash balance
                </span>
              </div>

              <div className="metric-card">
                <span className="metric-label">INVESTED ASSETS</span>
                <strong className="metric-value">
                  {shortMoney(investedAssets)}
                </strong>
                <span className="metric-note">
                  Opening values plus tracked positions
                </span>
              </div>

              <div className="metric-card">
                <span className="metric-label">AVAILABLE CASH</span>
                <strong className="metric-value">
                  {shortMoney(cashBalance)}
                </strong>
                <span className="metric-note">
                  After recorded transactions
                </span>
              </div>

              <div className="metric-card">
                <span className="metric-label">REALIZED GAIN / LOSS</span>
                <strong className="metric-value">
                  {shortMoney(realizedGain)}
                </strong>
                <span className="metric-note">
                  Tracked sales using average cost
                </span>
              </div>
            </section>

            <section className="content-grid">
              <div className="panel allocation-panel">
                <div className="panel-heading">
                  <div>
                    <h3>Asset Allocation</h3>
                    <p>Distribution by asset category</p>
                  </div>
                </div>

                {totalNetWorth > 0 ? (
                  <>
                    <div className="allocation-visual">
                      <div
                        className="donut"
                        style={{
                          background: `conic-gradient(${Object.entries(
                            allocation
                          )
                            .filter(([, value]) => value > 0)
                            .map((_, index, entries) => {
                              const start =
                                (entries
                                  .slice(0, index)
                                  .reduce(
                                    (sum, entry) => sum + entry[1],
                                    0
                                  ) /
                                  totalNetWorth) *
                                100;

                              const end =
                                (entries
                                  .slice(0, index + 1)
                                  .reduce(
                                    (sum, entry) => sum + entry[1],
                                    0
                                  ) /
                                  totalNetWorth) *
                                100;

                              return `${colors[index % colors.length]} ${start}% ${end}%`;
                            })
                            .join(', ')})`,
                        }}
                      >
                        <div className="donut-center">
                          <strong>{shortMoney(totalNetWorth)}</strong>
                          <span>Net worth</span>
                        </div>
                      </div>
                    </div>

                    <div className="allocation-legend">
                      {Object.entries(allocation)
                        .filter(([, value]) => value > 0)
                        .map(([category, value], index) => (
                          <div className="legend-row" key={category}>
                            <span
                              className="legend-dot"
                              style={{
                                background: colors[index % colors.length],
                              }}
                            />
                            <span className="legend-name">{category}</span>
                            <strong>
                              {(
                                (value / totalNetWorth) *
                                100
                              ).toFixed(1)}
                              %
                            </strong>
                          </div>
                        ))}
                    </div>
                  </>
                ) : (
                  <p className="empty-state">
                    No assets or cash recorded.
                  </p>
                )}
              </div>

              <div className="panel portfolio-panel">
                <div className="panel-heading">
                  <div>
                    <h3>Portfolio Overview</h3>
                    <p>Largest positions by current value</p>
                  </div>

                  <button
                    className="text-button"
                    onClick={() => setPage('My Portfolio')}
                  >
                    View all →
                  </button>
                </div>

                <div className="holdings-list">
                  {[...valuedAssets]
                    .sort((a, b) => b.value - a.value)
                    .slice(0, 5)
                    .map((asset) => (
                      <div className="holding-row" key={asset.id}>
                        <div className="asset-icon">
                          {asset.ticker.slice(0, 1)}
                        </div>

                        <div className="holding-info">
                          <strong>{asset.name}</strong>
                          <span>
                            {asset.ticker} · {asset.category}
                          </span>
                        </div>

                        <div className="holding-value">
                          <strong>{shortMoney(asset.value)}</strong>
                          <span>
                            {totalNetWorth > 0
                              ? `${(
                                  (asset.value / totalNetWorth) *
                                  100
                                ).toFixed(1)}%`
                              : '0%'}
                          </span>
                        </div>
                      </div>
                    ))}

                  <div className="holding-row">
                    <div className="asset-icon">€</div>

                    <div className="holding-info">
                      <strong>Cash Balance</strong>
                      <span>EUR · Cash</span>
                    </div>

                    <div className="holding-value">
                      <strong>{shortMoney(cashBalance)}</strong>
                      <span>
                        {totalNetWorth !== 0
                          ? `${(
                              (cashBalance / totalNetWorth) *
                              100
                            ).toFixed(1)}%`
                          : '0%'}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <section className="panel recent-panel">
              <div className="panel-heading">
                <div>
                  <h3>Recent Transactions</h3>
                  <p>Latest activity affecting your balances</p>
                </div>

                <button
                  className="text-button"
                  onClick={() => setPage('Transactions')}
                >
                  View history →
                </button>
              </div>

              {transactions.length === 0 ? (
                <p className="empty-state">
                  No transactions recorded yet.
                </p>
              ) : (
                <div className="recent-transactions">
                  {[...transactions]
                    .sort(
                      (a, b) =>
                        b.date.localeCompare(a.date) ||
                        b.id.localeCompare(a.id)
                    )
                    .slice(0, 5)
                    .map((tx) => (
                      <div className="recent-transaction" key={tx.id}>
                        <div>
                          <strong>
                            {tx.type} · {tx.ticker}
                          </strong>
                          <span>
                            {tx.date}
                            {tx.notes ? ` · ${tx.notes}` : ''}
                          </span>
                        </div>
                        <strong>{money(tx.amount)}</strong>
                      </div>
                    ))}
                </div>
              )}
            </section>

            <section
              className="panel"
              style={{ marginTop: 20, padding: 18 }}
            >
              <div
                className="panel-heading"
                style={{ padding: 0 }}
              >
                <div>
                  <h3>Opening Cash Balance</h3>
                  <p>
                    Cash held before the first transaction in your ledger.
                  </p>
                </div>

                <button
                  className="secondary-button"
                  onClick={editOpeningCash}
                >
                  Edit opening cash
                </button>
              </div>
            </section>
          </>
        )}

        {page === 'My Portfolio' && (
          <>
            <section className="welcome-row">
              <div>
                <h2>Manage your holdings</h2>
                <p>
                  Opening values represent existing holdings; tracked units
                  come from recorded trades.
                </p>
              </div>

              <button className="primary-button" onClick={openAddAsset}>
                + Add asset
              </button>
            </section>

            <section className="panel holdings-panel">
              <div className="portfolio-toolbar">
                <input
                  className="search-input"
                  type="search"
                  placeholder="Search assets..."
                  value={assetSearch}
                  onChange={(event) => setAssetSearch(event.target.value)}
                />
                <span className="results-count">
                  {filteredAssets.length} positions
                </span>
              </div>

              <div className="table-scroll">
                <table className="holdings-table">
                  <thead>
                    <tr>
                      <th>ASSET</th>
                      <th>CATEGORY</th>
                      <th>OPENING VALUE</th>
                      <th>TRACKED UNITS</th>
                      <th>MARKET PRICE</th>
                      <th>TOTAL VALUE</th>
                      <th>ACTIONS</th>
                    </tr>
                  </thead>

                  <tbody>
                    {filteredAssets.map((asset) => (
                      <tr key={asset.id}>
                        <td>
                          <div className="asset-cell">
                            <div className="asset-icon">
                              {asset.ticker.slice(0, 1)}
                            </div>
                            <div>
                              <strong>{asset.name}</strong>
                              <span>{asset.ticker}</span>
                            </div>
                          </div>
                        </td>

                        <td>
                          <span className="category-badge">
                            {asset.category}
                          </span>
                        </td>

                        <td>{money(asset.openingValue)}</td>
                        <td>{numberFormat(asset.quantity)}</td>
                        <td>
                          {asset.currentPrice > 0
                            ? money(asset.currentPrice)
                            : '—'}
                        </td>
                        <td>
                          <strong>{money(asset.value)}</strong>
                        </td>

                        <td>
                          <div className="table-actions">
                            <button
                              className="small-button"
                              onClick={() => openEditAsset(asset)}
                            >
                              Edit
                            </button>
                            <button
                              className="small-button delete-button"
                              onClick={() => deleteAsset(asset)}
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}

                    {filteredAssets.length === 0 && (
                      <tr>
                        <td colSpan={7} className="empty-table">
                          No assets found.
                        </td>
                      </tr>
                    )}
                  </tbody>

                  <tfoot>
                    <tr>
                      <td colSpan={5}>
                        <strong>Total invested assets</strong>
                      </td>
                      <td>
                        <strong>{money(totalAssets)}</strong>
                      </td>
                      <td />
                    </tr>
                    <tr>
                      <td colSpan={5}>
                        <strong>Cash balance</strong>
                      </td>
                      <td>
                        <strong>{money(cashBalance)}</strong>
                      </td>
                      <td />
                    </tr>
                    <tr>
                      <td colSpan={5}>
                        <strong>Total net worth</strong>
                      </td>
                      <td>
                        <strong>{money(totalNetWorth)}</strong>
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>

            <div className="portfolio-footer">
              <button className="secondary-button" onClick={resetDemo}>
                Reset demo data
              </button>
              <span>
                Opening values are not automatically revalued without tracked
                units and a current price.
              </span>
            </div>

            <section
              className="panel"
              style={{ marginTop: 20, padding: 18 }}
            >
              <h3 style={{ marginTop: 0 }}>Important: Opening Positions</h3>
              <p
                style={{
                  color: 'var(--muted)',
                  fontSize: 12,
                  lineHeight: 1.8,
                }}
              >
                Existing demo positions have opening values but no invented
                share quantities. To track sales and current market values
                accurately, edit each position and replace its opening value
                with 0, then enter your actual quantity and current market
                price. Do this only when you know the real figures. Recorded
                buys and sells will then update the tracked units automatically.
              </p>
            </section>
          </>
        )}

        {page === 'Transactions' && (
          <>
            <section className="welcome-row">
              <div>
                <h2>Transaction History</h2>
                <p>
                  Every saved transaction is replayed to calculate your
                  balances.
                </p>
              </div>

              <button
                className="primary-button"
                onClick={openAddTransaction}
              >
                + Add transaction
              </button>
            </section>

            <section className="metrics">
              <div className="metric-card">
                <span className="metric-label">TRANSACTIONS</span>
                <strong className="metric-value">
                  {transactions.length}
                </strong>
                <span className="metric-note">
                  All recorded operations
                </span>
              </div>

              <div className="metric-card">
                <span className="metric-label">NET DIVIDENDS</span>
                <strong className="metric-value">
                  {shortMoney(totalDividends)}
                </strong>
                <span className="metric-note">
                  Dividends after transaction fees
                </span>
              </div>

              <div className="metric-card">
                <span className="metric-label">RECORDED FEES</span>
                <strong className="metric-value">
                  {shortMoney(totalFees)}
                </strong>
                <span className="metric-note">Fees counted once</span>
              </div>

              <div className="metric-card">
                <span className="metric-label">REALIZED GAIN / LOSS</span>
                <strong className="metric-value">
                  {shortMoney(realizedGain)}
                </strong>
                <span className="metric-note">Tracked sales only</span>
              </div>
            </section>

            <section className="panel holdings-panel">
              <div className="transaction-toolbar">
                <input
                  className="search-input"
                  type="search"
                  placeholder="Search ticker, type or notes..."
                  value={transactionSearch}
                  onChange={(event) =>
                    setTransactionSearch(event.target.value)
                  }
                />

                <select
                  className="filter-select"
                  value={transactionTypeFilter}
                  onChange={(event) =>
                    setTransactionTypeFilter(event.target.value)
                  }
                >
                  <option value="All">All types</option>
                  {TRANSACTION_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </div>

              <div className="table-scroll">
                <table className="holdings-table transaction-table">
                  <thead>
                    <tr>
                      <th>DATE</th>
                      <th>TYPE</th>
                      <th>ASSET</th>
                      <th>AMOUNT (EUR)</th>
                      <th>QUANTITY</th>
                      <th>PRICE</th>
                      <th>FEE</th>
                      <th>REALIZED GAIN / LOSS</th>
                      <th>NOTES</th>
                      <th>ACTIONS</th>
                    </tr>
                  </thead>

                  <tbody>
                    {filteredTransactions.map((tx) => (
                      <tr key={tx.id}>
                        <td>{tx.date}</td>
                        <td>
                          <span
                            className={`transaction-type type-${tx.type.toLowerCase()}`}
                          >
                            {tx.type}
                          </span>
                        </td>
                        <td>
                          <strong>{tx.ticker}</strong>
                        </td>
                        <td>{money(tx.amount)}</td>
                        <td>
                          {tx.quantity
                            ? numberFormat(tx.quantity)
                            : '—'}
                        </td>
                        <td>
                          {tx.price ? money(tx.price) : '—'}
                        </td>
                        <td>{money(tx.fee)}</td>
                        <td>
                          {tx.type === 'Sell'
                            ? money(tx.realizedGain)
                            : '—'}
                        </td>
                        <td className="transaction-notes">
                          {tx.notes || '—'}
                        </td>
                        <td>
                          <div className="table-actions">
                            <button
                              className="small-button"
                              onClick={() => openEditTransaction(tx)}
                            >
                              Edit
                            </button>

                            <button
                              className="small-button delete-button"
                              onClick={() => deleteTransaction(tx)}
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}

                    {filteredTransactions.length === 0 && (
                      <tr>
                        <td colSpan={10} className="empty-table">
                          No transactions found. Add a transaction or change
                          your filters.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="table-bottom-note">
                {filteredTransactions.length} transaction(s) displayed.
                Amounts are in EUR.
              </div>
            </section>
          </>
        )}

        {page === 'Analytics' && (
          <Analytics
            assets={initialAssets}
            currentValue={totalNetWorth}
            openingValue={
              initialAssets.reduce(
                (sum, asset) => sum + asset.openingValue,
                0
              ) + openingCash
            }
            openingDate={openingDate}
            transactions={transactions}
          />
        )}

        {page === 'Market Data' && (
          <MarketDataImport
            assets={initialAssets}
            onPricesImported={async (symbol, latestPrice, quoteCurrency) => {
              const currency = quoteCurrency.toUpperCase();
              let eurPrice = latestPrice;
              if (currency !== 'EUR') {
                try {
                  const fxSymbol = `EUR${currency}=X`;
                  const fxResponse = await fetch(`${PORTFOLIO_API_URL}/api/history?symbol=${encodeURIComponent(fxSymbol)}&period=5d`);
                  const fxPayload: unknown = await fxResponse.json();
                  if (fxResponse.ok && isRecord(fxPayload) && Array.isArray(fxPayload.prices)) {
                    const latestFx = (fxPayload.prices as Array<Record<string, unknown>>)
                      .filter((item) => typeof item.close === 'number' && item.close > 0)
                      .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
                    if (latestFx && typeof latestFx.close === 'number') eurPrice = latestPrice / latestFx.close;
                    else throw new Error('No FX rate');
                  } else {
                    throw new Error('No FX rate');
                  }
                } catch {
                  setNotice(`Could not convert ${currency} to EUR for ${symbol}; market price was not updated.`);
                  return;
                }
              }
              const baseTicker = symbol.toUpperCase().split(/[.-]/)[0];
              setInitialAssets((current) => current.map((asset) => {
                if (asset.ticker.toUpperCase() !== baseTicker && asset.ticker.toUpperCase() !== symbol.toUpperCase()) return asset;
                return { ...asset, currentPrice: eurPrice, openingPrice: asset.openingPrice && asset.openingPrice > 0 ? asset.openingPrice : eurPrice };
              }));
            }}
          />
        )}

        {page === 'Simulator' && (
          <section className="panel placeholder-panel">
            <div className="placeholder-icon">⌁</div>
            <h2>Wealth Simulator</h2>
            <p>
              Contribution forecasts and scenario analysis will be added in a
              future release.
            </p>
            <button
              className="secondary-button"
              onClick={() => setPage('Dashboard')}
            >
              ← Back to Dashboard
            </button>
          </section>
        )}

        {showAssetForm && (
          <div
            className="modal-backdrop"
            onClick={() => setShowAssetForm(false)}
          >
            <section
              className="modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="asset-form-title"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="modal-heading">
                <div>
                  <h2 id="asset-form-title">
                    {editingAssetId ? 'Edit Asset' : 'Add Asset'}
                  </h2>
                  <p>
                    Opening value and tracked holdings are kept separate.
                  </p>
                </div>

                <button
                  className="close-button"
                  aria-label="Close form"
                  onClick={() => setShowAssetForm(false)}
                >
                  ×
                </button>
              </div>

              <form className="app-form" onSubmit={saveAsset}>
                <label>
                  Asset Name
                  <input
                    required
                    maxLength={80}
                    value={assetForm.name}
                    onChange={(event) =>
                      setAssetForm({
                        ...assetForm,
                        name: event.target.value,
                      })
                    }
                    placeholder="e.g. Global Equity ETF"
                  />
                </label>

                <label>
                  Ticker / Symbol
                  <input
                    required
                    maxLength={20}
                    value={assetForm.ticker}
                    onChange={(event) =>
                      setAssetForm({
                        ...assetForm,
                        ticker: event.target.value,
                      })
                    }
                    placeholder="e.g. VWCE"
                  />
                </label>

                <label>
                  Asset Category
                  <select
                    value={assetForm.category}
                    onChange={(event) =>
                      setAssetForm({
                        ...assetForm,
                        category: event.target.value,
                      })
                    }
                  >
                    {CATEGORIES.filter(
                      (category) => category !== 'Cash'
                    ).map((category) => (
                      <option key={category}>{category}</option>
                    ))}
                  </select>
                </label>

                <label>
                  Opening Value (EUR)
                  <input
                    required
                    type="number"
                    min="0"
                    step="0.01"
                    value={assetForm.openingValue}
                    onChange={(event) =>
                      setAssetForm({
                        ...assetForm,
                        openingValue: event.target.value,
                      })
                    }
                  />
                </label>

                <label>
                  Tracked Quantity
                  <input
                    required
                    type="number"
                    min="0"
                    step="any"
                    value={assetForm.quantity}
                    onChange={(event) =>
                      setAssetForm({
                        ...assetForm,
                        quantity: event.target.value,
                      })
                    }
                  />
                </label>

                <label>
                  Current Market Price (EUR)
                  <input
                    required
                    type="number"
                    min="0"
                    step="any"
                    value={assetForm.currentPrice}
                    onChange={(event) =>
                      setAssetForm({
                        ...assetForm,
                        currentPrice: event.target.value,
                      })
                    }
                  />
                </label>

                <p className="form-hint">
                  Total value = opening value + tracked quantity × current
                  market price. Opening values represent legacy holdings; they
                  are not trade lots. Enter 0 as the opening value when
                  migrating a position to real tracked units.
                </p>

                <div className="form-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setShowAssetForm(false)}
                  >
                    Cancel
                  </button>

                  <button type="submit" className="primary-button">
                    {editingAssetId ? 'Save Changes' : 'Add Asset'}
                  </button>
                </div>
              </form>
            </section>
          </div>
        )}

        {showTransactionForm && (
          <div
            className="modal-backdrop"
            onClick={() => setShowTransactionForm(false)}
          >
            <section
              className="modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="transaction-form-title"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="modal-heading">
                <div>
                  <h2 id="transaction-form-title">
                    {editingTransactionId ? 'Edit Transaction' : 'Add Transaction'}
                  </h2>
                  <p>
                    Saved operations recalculate cash and tracked holdings.
                  </p>
                </div>

                <button
                  className="close-button"
                  aria-label="Close form"
                  onClick={() => setShowTransactionForm(false)}
                >
                  ×
                </button>
              </div>

              <form className="app-form" onSubmit={saveTransaction}>
                <label>
                  Transaction Type
                  <select
                    value={txForm.type}
                    onChange={(event) => {
                      const type = event.target.value as TransactionType;

                      setTxForm({
                        ...txForm,
                        type,
                        ticker: ['Deposit', 'Withdrawal', 'Fee'].includes(type)
                          ? 'EUR'
                          : txForm.ticker,
                        quantity: ['Buy', 'Sell'].includes(type)
                          ? txForm.quantity
                          : '',
                        price: ['Buy', 'Sell'].includes(type)
                          ? txForm.price
                          : '',
                      });
                    }}
                  >
                    {TRANSACTION_TYPES.map((type) => (
                      <option key={type}>{type}</option>
                    ))}
                  </select>
                </label>

                <label>
                  Transaction Date
                  <input
                    required
                    type="date"
                    value={txForm.date}
                    onChange={(event) =>
                      setTxForm({
                        ...txForm,
                        date: event.target.value,
                      })
                    }
                  />
                </label>

                {['Buy', 'Sell', 'Dividend'].includes(txForm.type) && (
                  <label>
                    Asset Ticker
                    <select
                      required
                      value={txForm.ticker}
                      onChange={(event) =>
                        setTxForm({
                          ...txForm,
                          ticker: event.target.value,
                        })
                      }
                    >
                      <option value="">Select an asset</option>
                      {initialAssets.map((asset) => (
                        <option key={asset.id} value={asset.ticker}>
                          {asset.ticker} — {asset.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                <label>
                  {txForm.type === 'Dividend'
                    ? 'Gross Dividend (EUR)'
                    : txForm.type === 'Deposit'
                      ? 'Deposit Amount (EUR)'
                      : txForm.type === 'Withdrawal'
                        ? 'Withdrawal Amount (EUR)'
                        : txForm.type === 'Fee'
                          ? 'Fee Amount (EUR)'
                          : 'Trade Amount (EUR)'}

                  <input
                    required
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={txForm.amount}
                    onChange={(event) =>
                      setTxForm({
                        ...txForm,
                        amount: event.target.value,
                      })
                    }
                    placeholder="e.g. 500"
                  />
                </label>

                {['Buy', 'Sell'].includes(txForm.type) && (
                  <>
                    <label>
                      Quantity
                      <input
                        required
                        type="number"
                        min="0.00000001"
                        step="any"
                        value={txForm.quantity}
                        onChange={(event) =>
                          setTxForm({
                            ...txForm,
                            quantity: event.target.value,
                          })
                        }
                        placeholder="e.g. 2.5"
                      />
                    </label>

                    <label>
                      Unit Price (EUR)
                      <input
                        required
                        type="number"
                        min="0.00000001"
                        step="any"
                        value={txForm.price}
                        onChange={(event) =>
                          setTxForm({
                            ...txForm,
                            price: event.target.value,
                          })
                        }
                        placeholder="e.g. 200"
                      />
                    </label>
                  </>
                )}

                <label>
                  Transaction Fee (EUR)
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={txForm.fee}
                    onChange={(event) =>
                      setTxForm({
                        ...txForm,
                        fee: event.target.value,
                      })
                    }
                  />
                </label>

                <label>
                  Notes (Optional)
                  <input
                    maxLength={200}
                    value={txForm.notes}
                    onChange={(event) =>
                      setTxForm({
                        ...txForm,
                        notes: event.target.value,
                      })
                    }
                    placeholder="e.g. Monthly DCA"
                  />
                </label>

                <p className="form-hint">
                  For buys and sells, amount must equal quantity × unit price.
                  Fees are recorded separately and affect cash once. Buy/sell
                  quantities update tracked units; dividends do not add units.
                  Deposits and withdrawals affect cash, not investment
                  performance.
                </p>

                <div className="form-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setShowTransactionForm(false)}
                  >
                    Cancel
                  </button>

                  <button type="submit" className="primary-button">
                    {editingTransactionId ? 'Save Changes' : 'Save Transaction'}
                  </button>
                </div>
              </form>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
