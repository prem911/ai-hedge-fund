import { getCache } from "../data/cache.js";
import {
  type Price,
  PriceResponseSchema,
  type FinancialMetrics,
  FinancialMetricsResponseSchema,
  type LineItem,
  LineItemResponseSchema,
  type InsiderTrade,
  InsiderTradeResponseSchema,
  type CompanyNews,
  CompanyNewsResponseSchema,
  CompanyFactsResponseSchema,
} from "../data/models.js";

const _cache = getCache();

// ─── Rate-limited fetch helper ────────────────────────────────────────────────
export async function makeApiRequest(
  url: string,
  headers: Record<string, string>,
  method: "GET" | "POST" = "GET",
  body?: Record<string, unknown>,
  maxRetries = 3
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const opts: RequestInit = { method, headers };
    if (method === "POST" && body) {
      opts.body = JSON.stringify(body);
      (headers as Record<string, string>)["Content-Type"] = "application/json";
    }

    const response = await fetch(url, opts);

    if (response.status === 429 && attempt < maxRetries) {
      const delay = 60_000 + 30_000 * attempt;
      console.warn(`Rate limited (429). Attempt ${attempt + 1}/${maxRetries + 1}. Waiting ${delay / 1000}s…`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    return response;
  }
  // Should be unreachable, but TypeScript needs it
  return fetch(url, { method, headers });
}

// ─── getPrices ────────────────────────────────────────────────────────────────
export async function getPrices(
  ticker: string,
  startDate: string,
  endDate: string,
  apiKey?: string
): Promise<Price[]> {
  const cacheKey = `${ticker}_${startDate}_${endDate}`;
  const cached = _cache.getPrices(cacheKey);
  if (cached) {
    const parsed = PriceResponseSchema.safeParse({ ticker, prices: cached });
    if (parsed.success) return parsed.data.prices;
  }

  const financialApiKey = apiKey ?? process.env["FINANCIAL_DATASETS_API_KEY"];
  const headers: Record<string, string> = {};
  if (financialApiKey) headers["X-API-KEY"] = financialApiKey;

  const url = `https://api.financialdatasets.ai/prices/?ticker=${ticker}&interval=day&interval_multiplier=1&start_date=${startDate}&end_date=${endDate}`;
  const response = await makeApiRequest(url, headers);
  if (!response.ok) return [];

  try {
    const data = await response.json();
    const parsed = PriceResponseSchema.safeParse(data);
    if (!parsed.success) return [];
    const prices = parsed.data.prices;
    if (!prices.length) return [];

    _cache.setPrices(cacheKey, prices.map((p) => ({ ...p })));
    return prices;
  } catch {
    return [];
  }
}

// ─── getFinancialMetrics ──────────────────────────────────────────────────────
export async function getFinancialMetrics(
  ticker: string,
  endDate: string,
  period = "ttm",
  limit = 10,
  apiKey?: string
): Promise<FinancialMetrics[]> {
  const cacheKey = `${ticker}_${period}_${endDate}_${limit}`;
  const cached = _cache.getFinancialMetrics(cacheKey);
  if (cached) {
    const parsed = FinancialMetricsResponseSchema.safeParse({ financial_metrics: cached });
    if (parsed.success) return parsed.data.financial_metrics;
  }

  const financialApiKey = apiKey ?? process.env["FINANCIAL_DATASETS_API_KEY"];
  const headers: Record<string, string> = {};
  if (financialApiKey) headers["X-API-KEY"] = financialApiKey;

  const url = `https://api.financialdatasets.ai/financial-metrics/?ticker=${ticker}&report_period_lte=${endDate}&limit=${limit}&period=${period}`;
  const response = await makeApiRequest(url, headers);
  if (!response.ok) return [];

  try {
    const data = await response.json();
    const parsed = FinancialMetricsResponseSchema.safeParse(data);
    if (!parsed.success) return [];
    const metrics = parsed.data.financial_metrics;
    if (!metrics.length) return [];

    _cache.setFinancialMetrics(cacheKey, metrics.map((m) => ({ ...m })));
    return metrics;
  } catch {
    return [];
  }
}

// ─── searchLineItems ──────────────────────────────────────────────────────────
export async function searchLineItems(
  ticker: string,
  lineItems: string[],
  endDate: string,
  period = "ttm",
  limit = 10,
  apiKey?: string
): Promise<LineItem[]> {
  const financialApiKey = apiKey ?? process.env["FINANCIAL_DATASETS_API_KEY"];
  const headers: Record<string, string> = {};
  if (financialApiKey) headers["X-API-KEY"] = financialApiKey;

  const url = "https://api.financialdatasets.ai/financials/search/line-items";
  const body = { tickers: [ticker], line_items: lineItems, end_date: endDate, period, limit };

  const response = await makeApiRequest(url, headers, "POST", body);
  if (!response.ok) return [];

  try {
    const data = await response.json();
    const parsed = LineItemResponseSchema.safeParse(data);
    if (!parsed.success) return [];
    return parsed.data.search_results.slice(0, limit);
  } catch {
    return [];
  }
}

// ─── getInsiderTrades ─────────────────────────────────────────────────────────
export async function getInsiderTrades(
  ticker: string,
  endDate: string,
  startDate?: string,
  limit = 1000,
  apiKey?: string
): Promise<InsiderTrade[]> {
  const cacheKey = `${ticker}_${startDate ?? "none"}_${endDate}_${limit}`;
  const cached = _cache.getInsiderTrades(cacheKey);
  if (cached) {
    const parsed = InsiderTradeResponseSchema.safeParse({ insider_trades: cached });
    if (parsed.success) return parsed.data.insider_trades;
  }

  const financialApiKey = apiKey ?? process.env["FINANCIAL_DATASETS_API_KEY"];
  const headers: Record<string, string> = {};
  if (financialApiKey) headers["X-API-KEY"] = financialApiKey;

  const allTrades: InsiderTrade[] = [];
  let currentEndDate = endDate;

  while (true) {
    let url = `https://api.financialdatasets.ai/insider-trades/?ticker=${ticker}&filing_date_lte=${currentEndDate}`;
    if (startDate) url += `&filing_date_gte=${startDate}`;
    url += `&limit=${limit}`;

    const response = await makeApiRequest(url, headers);
    if (!response.ok) break;

    try {
      const data = await response.json();
      const parsed = InsiderTradeResponseSchema.safeParse(data);
      if (!parsed.success) break;
      const trades = parsed.data.insider_trades;
      if (!trades.length) break;

      allTrades.push(...trades);

      if (!startDate || trades.length < limit) break;

      const oldest = trades
        .map((t) => t.filing_date)
        .sort()[0]
        ?.split("T")[0];
      if (!oldest) break;
      currentEndDate = oldest;
      if (currentEndDate <= startDate) break;
    } catch {
      break;
    }
  }

  if (!allTrades.length) return [];
  _cache.setInsiderTrades(cacheKey, allTrades.map((t) => ({ ...t })));
  return allTrades;
}

// ─── getCompanyNews ───────────────────────────────────────────────────────────
export async function getCompanyNews(
  ticker: string,
  endDate: string,
  startDate?: string,
  limit = 1000,
  apiKey?: string
): Promise<CompanyNews[]> {
  const cacheKey = `${ticker}_${startDate ?? "none"}_${endDate}_${limit}`;
  const cached = _cache.getCompanyNews(cacheKey);
  if (cached) {
    const parsed = CompanyNewsResponseSchema.safeParse({ news: cached });
    if (parsed.success) return parsed.data.news;
  }

  const financialApiKey = apiKey ?? process.env["FINANCIAL_DATASETS_API_KEY"];
  const headers: Record<string, string> = {};
  if (financialApiKey) headers["X-API-KEY"] = financialApiKey;

  const allNews: CompanyNews[] = [];
  let currentEndDate = endDate;

  while (true) {
    let url = `https://api.financialdatasets.ai/news/?ticker=${ticker}&end_date=${currentEndDate}`;
    if (startDate) url += `&start_date=${startDate}`;
    url += `&limit=${limit}`;

    const response = await makeApiRequest(url, headers);
    if (!response.ok) break;

    try {
      const data = await response.json();
      const parsed = CompanyNewsResponseSchema.safeParse(data);
      if (!parsed.success) break;
      const news = parsed.data.news;
      if (!news.length) break;

      allNews.push(...news);

      if (!startDate || news.length < limit) break;

      const oldest = news.map((n) => n.date).sort()[0]?.split("T")[0];
      if (!oldest) break;
      currentEndDate = oldest;
      if (currentEndDate <= startDate) break;
    } catch {
      break;
    }
  }

  if (!allNews.length) return [];
  _cache.setCompanyNews(cacheKey, allNews.map((n) => ({ ...n })));
  return allNews;
}

// ─── getMarketCap ─────────────────────────────────────────────────────────────
export async function getMarketCap(
  ticker: string,
  endDate: string,
  apiKey?: string
): Promise<number | null> {
  const today = new Date().toISOString().slice(0, 10);
  const financialApiKey = apiKey ?? process.env["FINANCIAL_DATASETS_API_KEY"];
  const headers: Record<string, string> = {};
  if (financialApiKey) headers["X-API-KEY"] = financialApiKey;

  if (endDate === today) {
    const url = `https://api.financialdatasets.ai/company/facts/?ticker=${ticker}`;
    const response = await makeApiRequest(url, headers);
    if (!response.ok) return null;

    try {
      const data = await response.json();
      const parsed = CompanyFactsResponseSchema.safeParse(data);
      if (!parsed.success) return null;
      return parsed.data.company_facts.market_cap ?? null;
    } catch {
      return null;
    }
  }

  const metrics = await getFinancialMetrics(ticker, endDate, undefined, undefined, apiKey);
  if (!metrics.length) return null;
  return metrics[0]!.market_cap ?? null;
}

// ─── PriceDataFrame ────────────────────────────────────────────────────────────
// Lightweight replacement for pandas/danfojs DataFrame — stores price rows
// indexed by date string for quick lookup.
export interface PriceDataFrame {
  rows: (Price & { Date: string })[];
  /** Get a column as an array of numbers */
  col(name: keyof Price): number[];
  /** Get a row by date string */
  atDate(date: string): (Price & { Date: string }) | undefined;
}

export function pricesToDf(prices: Price[]): PriceDataFrame {
  const rows = prices
    .map((p) => ({ ...p, Date: p.time.split("T")[0]! }))
    .sort((a, b) => a.Date.localeCompare(b.Date));

  return {
    rows,
    col(name: keyof Price) {
      return rows.map((r) => r[name] as number);
    },
    atDate(date: string) {
      return rows.find((r) => r.Date === date);
    },
  };
}

// ─── getPriceData ─────────────────────────────────────────────────────────────
export async function getPriceData(
  ticker: string,
  startDate: string,
  endDate: string,
  apiKey?: string
): Promise<PriceDataFrame> {
  const prices = await getPrices(ticker, startDate, endDate, apiKey);
  return pricesToDf(prices);
}
