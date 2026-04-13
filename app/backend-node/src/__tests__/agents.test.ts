import { describe, it, expect, vi } from "vitest";
import { calculateTrend, analyzeGrowthTrends } from "../core/agents/growthAgent.js";
import { calculateConfidenceScore } from "../core/agents/newsSentiment.js";
import type { FinancialMetrics } from "../core/data/models.js";
import type { CompanyNews } from "../core/data/models.js";

// ─── calculateTrend ────────────────────────────────────────────────────────────

describe("calculateTrend", () => {
  it("returns a positive slope for increasing data", () => {
    const slope = calculateTrend([1, 2, 3, 4, 5]);
    expect(slope).toBeGreaterThan(0);
  });

  it("returns 0 for empty array", () => {
    expect(calculateTrend([])).toBe(0);
  });

  it("returns 0 for single element", () => {
    expect(calculateTrend([5])).toBe(0);
  });

  it("returns a negative slope for decreasing data", () => {
    expect(calculateTrend([5, 4, 3, 2, 1])).toBeLessThan(0);
  });

  it("handles null values by filtering them out", () => {
    const slope = calculateTrend([1, null, 2, null, 3]);
    expect(slope).toBeGreaterThan(0);
  });
});

// ─── analyzeGrowthTrends ───────────────────────────────────────────────────────

describe("analyzeGrowthTrends", () => {
  it("returns score between 0 and 1 for strong growth data", () => {
    const mockMetrics = Array(12).fill(null).map(() => ({
      ticker: "AAPL",
      report_period: "2024-12-31",
      period: "ttm",
      currency: "USD",
      revenue_growth: 0.25,
      earnings_per_share_growth: 0.20,
      free_cash_flow_growth: 0.18,
      gross_margin: 0.6,
      operating_margin: 0.2,
      net_margin: 0.15,
      peg_ratio: 0.8,
      price_to_sales_ratio: 1.5,
      // all other fields null
      market_cap: null, enterprise_value: null, price_to_earnings_ratio: null,
      price_to_book_ratio: null, enterprise_value_to_ebitda_ratio: null,
      enterprise_value_to_revenue_ratio: null, free_cash_flow_yield: null,
      return_on_equity: null, return_on_assets: null, return_on_invested_capital: null,
      asset_turnover: null, inventory_turnover: null, receivables_turnover: null,
      days_sales_outstanding: null, operating_cycle: null, working_capital_turnover: null,
      current_ratio: null, quick_ratio: null, cash_ratio: null, operating_cash_flow_ratio: null,
      debt_to_equity: null, debt_to_assets: null, interest_coverage: null,
      earnings_growth: null, book_value_growth: null, operating_income_growth: null,
      ebitda_growth: null, payout_ratio: null, earnings_per_share: null,
      book_value_per_share: null, free_cash_flow_per_share: null,
    })) as FinancialMetrics[];

    const result = analyzeGrowthTrends(mockMetrics);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.score).toBeGreaterThan(0.5); // Strong data should score well
  });

  it("returns low score for no growth data", () => {
    const mockMetrics = Array(12).fill(null).map(() => ({
      ticker: "XYZ",
      report_period: "2024-12-31",
      period: "ttm",
      currency: "USD",
      revenue_growth: null,
      earnings_per_share_growth: null,
      free_cash_flow_growth: null,
      gross_margin: null,
      operating_margin: null,
      net_margin: null,
      peg_ratio: null,
      price_to_sales_ratio: null,
      market_cap: null, enterprise_value: null, price_to_earnings_ratio: null,
      price_to_book_ratio: null, enterprise_value_to_ebitda_ratio: null,
      enterprise_value_to_revenue_ratio: null, free_cash_flow_yield: null,
      return_on_equity: null, return_on_assets: null, return_on_invested_capital: null,
      asset_turnover: null, inventory_turnover: null, receivables_turnover: null,
      days_sales_outstanding: null, operating_cycle: null, working_capital_turnover: null,
      current_ratio: null, quick_ratio: null, cash_ratio: null, operating_cash_flow_ratio: null,
      debt_to_equity: null, debt_to_assets: null, interest_coverage: null,
      earnings_growth: null, book_value_growth: null, operating_income_growth: null,
      ebitda_growth: null, payout_ratio: null, earnings_per_share: null,
      book_value_per_share: null, free_cash_flow_per_share: null,
    })) as FinancialMetrics[];

    const result = analyzeGrowthTrends(mockMetrics);
    expect(result.score).toBe(0);
  });
});

// ─── calculateConfidenceScore ─────────────────────────────────────────────────

describe("calculateConfidenceScore", () => {
  it("returns 0 when there are no signals", () => {
    const result = calculateConfidenceScore(new Map(), [], "neutral", 0, 0, 0);
    expect(result).toBe(0);
  });

  it("returns proportion-based confidence when no LLM confidences (Map is empty)", () => {
    const news: CompanyNews[] = [
      { ticker: "AAPL", title: "t1", source: "s", date: "d", url: "u", sentiment: "positive" },
      { ticker: "AAPL", title: "t2", source: "s", date: "d", url: "u", sentiment: "positive" },
      { ticker: "AAPL", title: "t3", source: "s", date: "d", url: "u", sentiment: "negative" },
    ];
    // 70% bullish signals → confidence = round(7/10 * 100) = 70
    const result = calculateConfidenceScore(new Map(), news, "bullish", 7, 3, 10);
    expect(result).toBe(70);
  });

  it("returns LLM-weighted confidence when confidences are available", () => {
    const news: CompanyNews[] = [
      { ticker: "AAPL", title: "Great results", source: "s", date: "d", url: "u", sentiment: "positive" },
    ];
    const confidenceMap = new Map<object, number>([[news[0]!, 80]]);
    // 70% * 80 (avg llm conf for matching articles) + 30% * (1/1 * 100) = 56 + 30 = 86
    const result = calculateConfidenceScore(confidenceMap, news, "bullish", 1, 0, 1);
    expect(result).toBe(86);
  });

  it("falls back to proportion-based when no matching articles for LLM confidence", () => {
    const news: CompanyNews[] = [
      { ticker: "AAPL", title: "t", source: "s", date: "d", url: "u", sentiment: "negative" },
    ];
    // LLM confidence map has data, but signal is bearish — matching article is "negative"
    const confidenceMap = new Map<object, number>([[news[0]!, 90]]);
    // 70% * 90 + 30% * (1/1 * 100) = 63 + 30 = 93
    const result = calculateConfidenceScore(confidenceMap, news, "bearish", 0, 1, 1);
    expect(result).toBe(93);
  });
});

// ─── fundamentalsAnalystAgent ─────────────────────────────────────────────────

describe("fundamentalsAnalystAgent", () => {
  it("returns bullish signal when all metrics are strong", async () => {
    const mockMetrics: FinancialMetrics[] = [{
      ticker: "AAPL",
      report_period: "2024-12-31",
      period: "ttm",
      currency: "USD",
      market_cap: 3e12,
      return_on_equity: 0.20,         // > 15% ✓
      net_margin: 0.25,               // > 20% ✓
      operating_margin: 0.18,         // > 15% ✓
      revenue_growth: 0.15,           // > 10% ✓
      earnings_growth: 0.15,          // > 10% ✓
      book_value_growth: 0.12,        // > 10% ✓
      current_ratio: 2.0,             // > 1.5 ✓
      debt_to_equity: 0.3,            // < 0.5 ✓
      free_cash_flow_per_share: 5.0,  // > EPS*0.8 ✓
      earnings_per_share: 4.0,
      price_to_earnings_ratio: 20,    // < 25 ✓
      price_to_book_ratio: 2,         // < 3 ✓
      price_to_sales_ratio: 3,        // < 5 ✓
      enterprise_value: null,
      enterprise_value_to_ebitda_ratio: null, enterprise_value_to_revenue_ratio: null,
      free_cash_flow_yield: null, peg_ratio: null, gross_margin: null,
      return_on_assets: null, return_on_invested_capital: null,
      asset_turnover: null, inventory_turnover: null, receivables_turnover: null,
      days_sales_outstanding: null, operating_cycle: null, working_capital_turnover: null,
      quick_ratio: null, cash_ratio: null, operating_cash_flow_ratio: null,
      debt_to_assets: null, interest_coverage: null,
      earnings_per_share_growth: null, free_cash_flow_growth: null, operating_income_growth: null,
      ebitda_growth: null, payout_ratio: null, book_value_per_share: null,
    }];

    // Mock the getFinancialMetrics function
    vi.mock("../core/tools/api.js", () => ({
      getFinancialMetrics: vi.fn().mockResolvedValue(mockMetrics),
      getInsiderTrades: vi.fn().mockResolvedValue([]),
      getCompanyNews: vi.fn().mockResolvedValue([]),
      getMarketCap: vi.fn().mockResolvedValue(3e12),
      searchLineItems: vi.fn().mockResolvedValue([]),
      getPrices: vi.fn().mockResolvedValue([]),
      getPriceData: vi.fn().mockResolvedValue({ rows: [], col: () => [], atDate: () => undefined }),
    }));

    const { fundamentalsAnalystAgent } = await import("../core/agents/fundamentals.js");

    const state = {
      messages: [],
      data: {
        tickers: ["AAPL"],
        end_date: "2024-01-01",
        analyst_signals: {},
      },
      metadata: { show_reasoning: false },
    };

    const result = await fundamentalsAnalystAgent(state);
    const signals = result.data?.["analyst_signals"] as Record<string, Record<string, { signal: string }>>;
    expect(signals?.["fundamentals_analyst_agent"]?.["AAPL"]?.signal).toBe("bullish");
  });
});
