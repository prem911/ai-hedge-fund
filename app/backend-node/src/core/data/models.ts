import { z } from "zod";

// ─── Price ────────────────────────────────────────────────────────────────────
export const PriceSchema = z.object({
  open: z.number(),
  close: z.number(),
  high: z.number(),
  low: z.number(),
  volume: z.number(),
  time: z.string(),
});
export type Price = z.infer<typeof PriceSchema>;

export const PriceResponseSchema = z.object({
  ticker: z.string(),
  prices: z.array(PriceSchema),
});
export type PriceResponse = z.infer<typeof PriceResponseSchema>;

// ─── FinancialMetrics ─────────────────────────────────────────────────────────
export const FinancialMetricsSchema = z.object({
  ticker: z.string(),
  report_period: z.string(),
  period: z.string(),
  currency: z.string(),
  market_cap: z.number().nullable(),
  enterprise_value: z.number().nullable(),
  price_to_earnings_ratio: z.number().nullable(),
  price_to_book_ratio: z.number().nullable(),
  price_to_sales_ratio: z.number().nullable(),
  enterprise_value_to_ebitda_ratio: z.number().nullable(),
  enterprise_value_to_revenue_ratio: z.number().nullable(),
  free_cash_flow_yield: z.number().nullable(),
  peg_ratio: z.number().nullable(),
  gross_margin: z.number().nullable(),
  operating_margin: z.number().nullable(),
  net_margin: z.number().nullable(),
  return_on_equity: z.number().nullable(),
  return_on_assets: z.number().nullable(),
  return_on_invested_capital: z.number().nullable(),
  asset_turnover: z.number().nullable(),
  inventory_turnover: z.number().nullable(),
  receivables_turnover: z.number().nullable(),
  days_sales_outstanding: z.number().nullable(),
  operating_cycle: z.number().nullable(),
  working_capital_turnover: z.number().nullable(),
  current_ratio: z.number().nullable(),
  quick_ratio: z.number().nullable(),
  cash_ratio: z.number().nullable(),
  operating_cash_flow_ratio: z.number().nullable(),
  debt_to_equity: z.number().nullable(),
  debt_to_assets: z.number().nullable(),
  interest_coverage: z.number().nullable(),
  revenue_growth: z.number().nullable(),
  earnings_growth: z.number().nullable(),
  book_value_growth: z.number().nullable(),
  earnings_per_share_growth: z.number().nullable(),
  free_cash_flow_growth: z.number().nullable(),
  operating_income_growth: z.number().nullable(),
  ebitda_growth: z.number().nullable(),
  payout_ratio: z.number().nullable(),
  earnings_per_share: z.number().nullable(),
  book_value_per_share: z.number().nullable(),
  free_cash_flow_per_share: z.number().nullable(),
});
export type FinancialMetrics = z.infer<typeof FinancialMetricsSchema>;

export const FinancialMetricsResponseSchema = z.object({
  financial_metrics: z.array(FinancialMetricsSchema),
});
export type FinancialMetricsResponse = z.infer<typeof FinancialMetricsResponseSchema>;

// ─── LineItem ─────────────────────────────────────────────────────────────────
export const LineItemSchema = z
  .object({
    ticker: z.string(),
    report_period: z.string(),
    period: z.string(),
    currency: z.string(),
  })
  .passthrough();
export type LineItem = z.infer<typeof LineItemSchema>;

export const LineItemResponseSchema = z.object({
  search_results: z.array(LineItemSchema),
});
export type LineItemResponse = z.infer<typeof LineItemResponseSchema>;

// ─── InsiderTrade ─────────────────────────────────────────────────────────────
export const InsiderTradeSchema = z.object({
  ticker: z.string(),
  issuer: z.string().nullable(),
  name: z.string().nullable(),
  title: z.string().nullable(),
  is_board_director: z.boolean().nullable(),
  transaction_date: z.string().nullable(),
  transaction_shares: z.number().nullable(),
  transaction_price_per_share: z.number().nullable(),
  transaction_value: z.number().nullable(),
  shares_owned_before_transaction: z.number().nullable(),
  shares_owned_after_transaction: z.number().nullable(),
  security_title: z.string().nullable(),
  filing_date: z.string(),
});
export type InsiderTrade = z.infer<typeof InsiderTradeSchema>;

export const InsiderTradeResponseSchema = z.object({
  insider_trades: z.array(InsiderTradeSchema),
});
export type InsiderTradeResponse = z.infer<typeof InsiderTradeResponseSchema>;

// ─── CompanyNews ──────────────────────────────────────────────────────────────
export const CompanyNewsSchema = z.object({
  ticker: z.string(),
  title: z.string(),
  author: z.string().optional().nullable(),
  source: z.string(),
  date: z.string(),
  url: z.string(),
  sentiment: z.string().optional().nullable(),
});
export type CompanyNews = z.infer<typeof CompanyNewsSchema>;

export const CompanyNewsResponseSchema = z.object({
  news: z.array(CompanyNewsSchema),
});
export type CompanyNewsResponse = z.infer<typeof CompanyNewsResponseSchema>;

// ─── CompanyFacts ─────────────────────────────────────────────────────────────
export const CompanyFactsSchema = z.object({
  ticker: z.string(),
  name: z.string(),
  cik: z.string().optional().nullable(),
  industry: z.string().optional().nullable(),
  sector: z.string().optional().nullable(),
  category: z.string().optional().nullable(),
  exchange: z.string().optional().nullable(),
  is_active: z.boolean().optional().nullable(),
  listing_date: z.string().optional().nullable(),
  location: z.string().optional().nullable(),
  market_cap: z.number().optional().nullable(),
  number_of_employees: z.number().int().optional().nullable(),
  sec_filings_url: z.string().optional().nullable(),
  sic_code: z.string().optional().nullable(),
  sic_industry: z.string().optional().nullable(),
  sic_sector: z.string().optional().nullable(),
  website_url: z.string().optional().nullable(),
  weighted_average_shares: z.number().int().optional().nullable(),
});
export type CompanyFacts = z.infer<typeof CompanyFactsSchema>;

export const CompanyFactsResponseSchema = z.object({
  company_facts: CompanyFactsSchema,
});
export type CompanyFactsResponse = z.infer<typeof CompanyFactsResponseSchema>;

// ─── Portfolio ────────────────────────────────────────────────────────────────
export const PositionSchema = z.object({
  cash: z.number().default(0.0),
  shares: z.number().int().default(0),
  ticker: z.string(),
});
export type Position = z.infer<typeof PositionSchema>;

export const PortfolioSchema = z.object({
  positions: z.record(PositionSchema),
  total_cash: z.number().default(0.0),
});
export type Portfolio = z.infer<typeof PortfolioSchema>;

// ─── Agent signals & state ────────────────────────────────────────────────────
export const AnalystSignalSchema = z.object({
  signal: z.string().optional().nullable(),
  confidence: z.number().optional().nullable(),
  reasoning: z.union([z.record(z.any()), z.string()]).optional().nullable(),
  max_position_size: z.number().optional().nullable(),
});
export type AnalystSignal = z.infer<typeof AnalystSignalSchema>;

export const TickerAnalysisSchema = z.object({
  ticker: z.string(),
  analyst_signals: z.record(AnalystSignalSchema),
});
export type TickerAnalysis = z.infer<typeof TickerAnalysisSchema>;

export const AgentStateDataSchema = z.object({
  tickers: z.array(z.string()),
  portfolio: z.record(z.any()),
  start_date: z.string(),
  end_date: z.string(),
  ticker_analyses: z.record(TickerAnalysisSchema),
});
export type AgentStateData = z.infer<typeof AgentStateDataSchema>;

export const AgentStateMetadataSchema = z
  .object({
    show_reasoning: z.boolean().default(false),
  })
  .passthrough();
export type AgentStateMetadata = z.infer<typeof AgentStateMetadataSchema>;
