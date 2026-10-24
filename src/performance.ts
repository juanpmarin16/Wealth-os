
export type ExternalCashFlowType = "contribution" | "withdrawal";

export interface ExternalCashFlow {
  date: string;
  type: ExternalCashFlowType;
  amount: number;
  description?: string;
}

export interface PortfolioValuation {
  date: string;
  value: number;
}

export interface XirrResult {
  annualizedReturn: number | null;
  status: "ok" | "insufficient-data" | "no-solution";
  message: string;
}

export interface TwrPeriodResult {
  startDate: string;
  endDate: string;
  startValue: number;
  endValue: number;
  externalFlows: number;
  weightedFlows: number;
  return: number | null;
  status: "ok" | "invalid-period";
}

export interface TwrResult {
  cumulativeReturn: number | null;
  annualizedReturn: number | null;
  periods: TwrPeriodResult[];
  status: "ok" | "insufficient-data" | "invalid-data";
  method: "modified-dietz-linked";
  message: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function dateToUtc(date: string): number {
  const parsed = new Date(`${date.slice(0, 10)}T00:00:00.000Z`);
  const timestamp = parsed.getTime();

  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid date: ${date}`);
  }

  return timestamp;
}

function daysBetween(start: string, end: string): number {
  return (dateToUtc(end) - dateToUtc(start)) / DAY_MS;
}

function validateCashFlows(flows: ExternalCashFlow[]): void {
  for (const flow of flows) {
    if (!Number.isFinite(flow.amount) || flow.amount < 0) {
      throw new Error("Cash flow amounts must be non-negative numbers.");
    }

    dateToUtc(flow.date);
  }
}

/**
 * Converts external portfolio flows to the investor's perspective:
 * contributions are negative; withdrawals are positive.
 *
 * Buy, sell, dividend and fee transactions are intentionally excluded.
 */
export function toInvestorCashFlows(
  flows: ExternalCashFlow[],
): Array<{ date: string; amount: number; description: string }> {
  validateCashFlows(flows);

  return flows
    .map((flow) => ({
      date: flow.date.slice(0, 10),
      amount:
        flow.type === "contribution" ? -flow.amount : flow.amount,
      description:
        flow.description ?? flow.type,
    }))
    .sort((a, b) => dateToUtc(a.date) - dateToUtc(b.date));
}

/**
 * XIRR using actual calendar days and a 365-day year.
 *
 * Include:
 * - each contribution as a negative cash flow;
 * - each withdrawal as a positive cash flow;
 * - current portfolio value as a positive terminal cash flow.
 *
 * The opening portfolio value should be represented as a negative
 * investor cash flow on the chosen performance start date.
 */
export function calculateXirr(
  cashFlows: Array<{ date: string; amount: number }>,
): XirrResult {
  if (cashFlows.length < 2) {
    return {
      annualizedReturn: null,
      status: "insufficient-data",
      message: "At least two dated cash flows are required.",
    };
  }

  const flows = cashFlows.map((flow) => {
    dateToUtc(flow.date);

    if (!Number.isFinite(flow.amount)) {
      throw new Error("XIRR cash flows must be finite numbers.");
    }

    return {
      date: flow.date.slice(0, 10),
      amount: flow.amount,
    };
  });

  const hasPositive = flows.some((flow) => flow.amount > 0);
  const hasNegative = flows.some((flow) => flow.amount < 0);

  if (!hasPositive || !hasNegative) {
    return {
      annualizedReturn: null,
      status: "insufficient-data",
      message: "XIRR needs both negative and positive cash flows.",
    };
  }

  flows.sort((a, b) => dateToUtc(a.date) - dateToUtc(b.date));

  const firstDate = dateToUtc(flows[0].date);

  const npv = (rate: number): number => {
    if (rate <= -1) return Number.NaN;

    return flows.reduce((total, flow) => {
      const years = (dateToUtc(flow.date) - firstDate) / DAY_MS / 365;
      return total + flow.amount / Math.pow(1 + rate, years);
    }, 0);
  };

  // Search for a sign-changing interval above -100%.
  const candidates: number[] = [
    -0.9999, -0.99, -0.9, -0.75, -0.5, -0.25,
    -0.1, 0, 0.05, 0.1, 0.2, 0.35, 0.5,
    0.75, 1, 1.5, 2, 3, 5, 10, 20, 50, 100, 1000,
  ];

  let lower: number | null = null;
  let upper: number | null = null;
  let previousRate = candidates[0];
  let previousValue = npv(previousRate);

  for (let i = 1; i < candidates.length; i += 1) {
    const rate = candidates[i];
    const value = npv(rate);

    if (
      Number.isFinite(previousValue) &&
      Number.isFinite(value) &&
      (previousValue === 0 ||
        value === 0 ||
        Math.sign(previousValue) !== Math.sign(value))
    ) {
      lower = previousRate;
      upper = rate;
      break;
    }

    previousRate = rate;
    previousValue = value;
  }

  if (lower === null || upper === null) {
    return {
      annualizedReturn: null,
      status: "no-solution",
      message:
        "No XIRR solution was found in the search range. Check dates and cash-flow signs.",
    };
  }

  let low = lower;
  let high = upper;
  let lowNpv = npv(low);

  for (let i = 0; i < 250; i += 1) {
    const middle = (low + high) / 2;
    const middleNpv = npv(middle);

    if (!Number.isFinite(middleNpv)) break;

    if (Math.abs(middleNpv) < 1e-8 || Math.abs(high - low) < 1e-10) {
      return {
        annualizedReturn: middle,
        status: "ok",
        message: "Annualized money-weighted return calculated using actual dates.",
      };
    }

    if (Math.sign(middleNpv) === Math.sign(lowNpv)) {
      low = middle;
      lowNpv = middleNpv;
    } else {
      high = middle;
    }
  }

  const result = (low + high) / 2;

  if (!Number.isFinite(result) || result <= -1) {
    return {
      annualizedReturn: null,
      status: "no-solution",
      message: "A valid XIRR could not be calculated.",
    };
  }

  return {
    annualizedReturn: result,
    status: "ok",
    message: "Annualized money-weighted return calculated using actual dates.",
  };
}

/**
 * Creates the XIRR cash-flow series.
 * Opening value is negative, contributions are negative,
 * withdrawals are positive, and ending portfolio value is positive.
 */
export function buildXirrCashFlows(args: {
  startDate: string;
  openingValue: number;
  externalFlows: ExternalCashFlow[];
  endDate: string;
  endingValue: number;
}): Array<{ date: string; amount: number }> {
  const {
    startDate,
    openingValue,
    externalFlows,
    endDate,
    endingValue,
  } = args;

  dateToUtc(startDate);
  dateToUtc(endDate);
  validateCashFlows(externalFlows);

  if (daysBetween(startDate, endDate) <= 0) {
    throw new Error("The end date must be after the start date.");
  }

  if (
    !Number.isFinite(openingValue) ||
    openingValue < 0 ||
    !Number.isFinite(endingValue) ||
    endingValue < 0
  ) {
    throw new Error("Portfolio values must be non-negative numbers.");
  }

  const flows: Array<{ date: string; amount: number }> = [
    { date: startDate.slice(0, 10), amount: -openingValue },
  ];

  for (const flow of toInvestorCashFlows(externalFlows)) {
    if (flow.date > startDate.slice(0, 10) && flow.date <= endDate.slice(0, 10)) {
      flows.push({ date: flow.date, amount: flow.amount });
    }
  }

  flows.push({
    date: endDate.slice(0, 10),
    amount: endingValue,
  });

  return flows.sort((a, b) => dateToUtc(a.date) - dateToUtc(b.date));
}

/**
 * Calculates linked Modified Dietz returns between valuation snapshots.
 *
 * Flow sign from the portfolio's perspective:
 * contributions are positive; withdrawals are negative.
 *
 * This is an approximation to TWR, not exact daily TWR.
 * More accurate TWR requires valuations immediately before and after
 * each external flow, or sufficiently frequent dated valuations.
 */
export function calculateTwr(
  valuations: PortfolioValuation[],
  externalFlows: ExternalCashFlow[],
): TwrResult {
  validateCashFlows(externalFlows);

  const sortedValuations = valuations
    .map((valuation) => {
      dateToUtc(valuation.date);

      if (!Number.isFinite(valuation.value) || valuation.value < 0) {
        throw new Error("Valuation values must be non-negative numbers.");
      }

      return {
        date: valuation.date.slice(0, 10),
        value: valuation.value,
      };
    })
    .sort((a, b) => dateToUtc(a.date) - dateToUtc(b.date));

  for (let i = 1; i < sortedValuations.length; i += 1) {
    if (sortedValuations[i].date === sortedValuations[i - 1].date) {
      return {
        cumulativeReturn: null,
        annualizedReturn: null,
        periods: [],
        status: "invalid-data",
        method: "modified-dietz-linked",
        message: "Only one valuation per date is allowed.",
      };
    }
  }

  if (sortedValuations.length < 2) {
    return {
      cumulativeReturn: null,
      annualizedReturn: null,
      periods: [],
      status: "insufficient-data",
      method: "modified-dietz-linked",
      message: "Add at least two dated portfolio valuations to calculate TWR.",
    };
  }

  const periods: TwrPeriodResult[] = [];
  let linkedGrowth = 1;

  for (let i = 1; i < sortedValuations.length; i += 1) {
    const start = sortedValuations[i - 1];
    const end = sortedValuations[i];
    const duration = daysBetween(start.date, end.date);

    if (duration <= 0 || start.value <= 0) {
      periods.push({
        startDate: start.date,
        endDate: end.date,
        startValue: start.value,
        endValue: end.value,
        externalFlows: 0,
        weightedFlows: 0,
        return: null,
        status: "invalid-period",
      });

      return {
        cumulativeReturn: null,
        annualizedReturn: null,
        periods,
        status: "invalid-data",
        method: "modified-dietz-linked",
        message: "Each period needs a positive starting value and increasing dates.",
      };
    }

    const periodFlows = externalFlows.filter((flow) => {
      const date = flow.date.slice(0, 10);
      return date > start.date && date <= end.date;
    });

    let totalFlows = 0;
    let weightedFlows = 0;

    for (const flow of periodFlows) {
      // Portfolio perspective: contribution +, withdrawal -.
      const signedAmount =
        flow.type === "contribution" ? flow.amount : -flow.amount;

      const elapsedDays = daysBetween(start.date, flow.date);
      const weight = Math.max(0, Math.min(1, (duration - elapsedDays) / duration));

      totalFlows += signedAmount;
      weightedFlows += signedAmount * weight;
    }

    const denominator = start.value + weightedFlows;
    const periodReturn =
      denominator > 0
        ? (end.value - start.value - totalFlows) / denominator
        : Number.NaN;

    if (!Number.isFinite(periodReturn) || periodReturn <= -1) {
      periods.push({
        startDate: start.date,
        endDate: end.date,
        startValue: start.value,
        endValue: end.value,
        externalFlows: totalFlows,
        weightedFlows,
        return: null,
        status: "invalid-period",
      });

      return {
        cumulativeReturn: null,
        annualizedReturn: null,
        periods,
        status: "invalid-data",
        method: "modified-dietz-linked",
        message: "A period return could not be calculated. Check valuations and flows.",
      };
    }

    periods.push({
      startDate: start.date,
      endDate: end.date,
      startValue: start.value,
      endValue: end.value,
      externalFlows: totalFlows,
      weightedFlows,
      return: periodReturn,
      status: "ok",
    });

    linkedGrowth *= 1 + periodReturn;
  }

  const first = sortedValuations[0];
  const last = sortedValuations[sortedValuations.length - 1];
  const totalDays = daysBetween(first.date, last.date);
  const cumulativeReturn = linkedGrowth - 1;
  const annualizedReturn =
    totalDays > 0 && linkedGrowth > 0
      ? Math.pow(linkedGrowth, 365 / totalDays) - 1
      : null;

  return {
    cumulativeReturn,
    annualizedReturn,
    periods,
    status: "ok",
    method: "modified-dietz-linked",
    message:
      "Linked Modified Dietz estimate. Accuracy depends on the frequency and timing of valuation snapshots.",
  };
}
