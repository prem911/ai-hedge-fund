/**
 * BacktestService — Phase 4.
 *
 * Full translation of app/backend/services/backtest_service.py into TypeScript.
 * Iterates over business days, runs the compiled LangGraph graph for each day,
 * executes trades against a paper portfolio (long/short), streams per-cycle SSE
 * events via a progress callback, and calculates Sharpe/Sortino/MaxDrawdown.
 */

import { eachDayOfInterval, parseISO, isWeekend, format, subDays, subYears } from "date-fns";
import type { BacktestDayResult, BacktestPerformanceMetrics } from "../models/schemas.js";
import { runGraph, createGraph } from "./graphService.js";
import { getPriceData, getPrices, getFinancialMetrics, getInsiderTrades, getCompanyNews } from "../core/tools/api.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BacktestResult {
  results: BacktestDayResult[];
  performance_metrics: BacktestPerformanceMetrics;
  portfolio_values: Array<Record<string, unknown>>;
  final_portfolio: Record<string, unknown>;
}

export interface BacktestProgressUpdate {
  type: "progress" | "backtest_result";
  current_date?: string;
  progress?: number;
  total_dates?: number;
  current_step?: number;
  data?: Record<string, unknown>;
}

export type ProgressCallback = (update: BacktestProgressUpdate) => void;

// ─── Stats helpers (replace pandas/numpy) ────────────────────────────────────

function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1));
}

// ─── Business-day generation (replaces pd.date_range freq='B') ───────────────

function getBusinessDays(startDate: string, endDate: string): Date[] {
  return eachDayOfInterval({
    start: parseISO(startDate),
    end: parseISO(endDate),
  }).filter((d) => !isWeekend(d));
}

// ─── BacktestService ──────────────────────────────────────────────────────────

export class BacktestService {
  private graph: ReturnType<typeof createGraph>;
  private portfolio: Record<string, unknown>;
  private tickers: string[];
  private startDate: string;
  private endDate: string;
  private initialCapital: number;
  private modelName: string;
  private modelProvider: string;
  private request: Record<string, unknown>;
  private portfolioValues: Array<Record<string, unknown>>;

  constructor(params: {
    graph: ReturnType<typeof createGraph>;
    portfolio: Record<string, unknown>;
    tickers: string[];
    startDate: string;
    endDate: string;
    initialCapital: number;
    modelName?: string;
    modelProvider?: string;
    request?: Record<string, unknown>;
  }) {
    this.graph = params.graph;
    this.portfolio = params.portfolio;
    this.tickers = params.tickers;
    this.startDate = params.startDate;
    this.endDate = params.endDate;
    this.initialCapital = params.initialCapital;
    this.modelName = params.modelName ?? "gpt-4.1";
    this.modelProvider = params.modelProvider ?? "OpenAI";
    this.request = params.request ?? {};
    this.portfolioValues = [];
  }

  // ─── executeTrade ────────────────────────────────────────────────────────────

  executeTrade(ticker: string, action: string, quantity: number, currentPrice: number): number {
    if (quantity <= 0) return 0;

    quantity = Math.floor(quantity); // force integer shares
    const positions = this.portfolio["positions"] as Record<string, Record<string, number>>;
    const position = positions[ticker]!;
    const realizedGains = this.portfolio["realized_gains"] as Record<string, Record<string, number>>;

    if (action === "buy") {
      const cost = quantity * currentPrice;
      const cash = this.portfolio["cash"] as number;

      let actualQty = quantity;
      let actualCost = cost;

      if (cost > cash) {
        actualQty = Math.floor(cash / currentPrice);
        if (actualQty <= 0) return 0;
        actualCost = actualQty * currentPrice;
      }

      const oldShares = position["long"]!;
      const oldCostBasis = position["long_cost_basis"]!;
      const totalShares = oldShares + actualQty;

      if (totalShares > 0) {
        position["long_cost_basis"] = (oldCostBasis * oldShares + actualCost) / totalShares;
      }

      position["long"] += actualQty;
      this.portfolio["cash"] = cash - actualCost;
      return actualQty;
    }

    if (action === "sell") {
      const actualQty = Math.min(quantity, position["long"]!);
      if (actualQty <= 0) return 0;

      const avgCostPerShare = position["long"]! > 0 ? position["long_cost_basis"]! : 0;
      const realizedGain = (currentPrice - avgCostPerShare) * actualQty;
      realizedGains[ticker]!["long"] += realizedGain;

      position["long"] -= actualQty;
      this.portfolio["cash"] = (this.portfolio["cash"] as number) + actualQty * currentPrice;

      if (position["long"] === 0) position["long_cost_basis"] = 0;
      return actualQty;
    }

    if (action === "short") {
      const proceeds = currentPrice * quantity;
      const marginRatio = this.portfolio["margin_requirement"] as number;
      const marginRequired = proceeds * marginRatio;
      const marginUsed = this.portfolio["margin_used"] as number;
      const cash = this.portfolio["cash"] as number;
      const availableCash = Math.max(0, cash - marginUsed);

      let actualQty = quantity;
      let actualProceeds = proceeds;
      let actualMargin = marginRequired;

      if (marginRequired > availableCash) {
        if (marginRatio > 0) {
          actualQty = Math.floor(availableCash / (currentPrice * marginRatio));
        } else {
          actualQty = 0;
        }
        if (actualQty <= 0) return 0;
        actualProceeds = currentPrice * actualQty;
        actualMargin = actualProceeds * marginRatio;
      }

      const oldShortShares = position["short"]!;
      const oldCostBasis = position["short_cost_basis"]!;
      const totalShares = oldShortShares + actualQty;

      if (totalShares > 0) {
        position["short_cost_basis"] =
          (oldCostBasis * oldShortShares + currentPrice * actualQty) / totalShares;
      }

      position["short"] += actualQty;
      position["short_margin_used"] = (position["short_margin_used"] ?? 0) + actualMargin;
      this.portfolio["margin_used"] = marginUsed + actualMargin;
      this.portfolio["cash"] = cash + actualProceeds - actualMargin;
      return actualQty;
    }

    if (action === "cover") {
      const actualQty = Math.min(quantity, position["short"]!);
      if (actualQty <= 0) return 0;

      const coverCost = actualQty * currentPrice;
      const avgShortPrice = position["short"]! > 0 ? position["short_cost_basis"]! : 0;
      const realizedGain = (avgShortPrice - currentPrice) * actualQty;

      const portion = position["short"]! > 0 ? actualQty / position["short"]! : 1;
      const marginToRelease = portion * (position["short_margin_used"] ?? 0);

      position["short"] -= actualQty;
      position["short_margin_used"] = (position["short_margin_used"] ?? 0) - marginToRelease;
      this.portfolio["margin_used"] = (this.portfolio["margin_used"] as number) - marginToRelease;
      this.portfolio["cash"] =
        (this.portfolio["cash"] as number) + marginToRelease - coverCost;

      realizedGains[ticker]!["short"] += realizedGain;

      if (position["short"] === 0) {
        position["short_cost_basis"] = 0;
        position["short_margin_used"] = 0;
      }
      return actualQty;
    }

    return 0;
  }

  // ─── calculatePortfolioValue ──────────────────────────────────────────────────

  calculatePortfolioValue(currentPrices: Record<string, number>): number {
    let total = this.portfolio["cash"] as number;
    const positions = this.portfolio["positions"] as Record<string, Record<string, number>>;

    for (const ticker of this.tickers) {
      const position = positions[ticker]!;
      const price = currentPrices[ticker] ?? 0;
      total += position["long"]! * price;
      if ((position["short"] ?? 0) > 0) {
        total -= position["short"]! * price;
      }
    }
    return total;
  }

  // ─── prefetchData ─────────────────────────────────────────────────────────────

  async prefetchData(): Promise<void> {
    const endDateDt = parseISO(this.endDate);
    const startDateDt = subYears(endDateDt, 1);
    const startDateStr = format(startDateDt, "yyyy-MM-dd");

    const apiKeys = this.request["api_keys"] as Record<string, string> | undefined;
    const apiKey = apiKeys?.["FINANCIAL_DATASETS_API_KEY"];

    await Promise.all(
      this.tickers.flatMap((ticker) => [
        getPrices(ticker, startDateStr, this.endDate, apiKey),
        getFinancialMetrics(ticker, this.endDate, "ttm", 10, apiKey),
        getInsiderTrades(ticker, this.endDate, this.startDate, 1000, apiKey),
        getCompanyNews(ticker, this.endDate, this.startDate, 1000, apiKey),
      ])
    );
  }

  // ─── _updatePerformanceMetrics ────────────────────────────────────────────────

  _updatePerformanceMetrics(performanceMetrics: Record<string, unknown>): void {
    const values = this.portfolioValues
      .map((v) => v["Portfolio Value"] as number)
      .filter((v) => typeof v === "number" && isFinite(v));

    if (values.length < 2) return;

    // pct_change
    const dailyReturns: number[] = [];
    for (let i = 1; i < values.length; i++) {
      const prev = values[i - 1]!;
      const curr = values[i]!;
      if (prev !== 0) dailyReturns.push((curr - prev) / prev);
    }

    if (dailyReturns.length < 2) return;

    const dailyRiskFreeRate = 0.0434 / 252;
    const excessReturns = dailyReturns.map((r) => r - dailyRiskFreeRate);
    const meanExcess = mean(excessReturns);
    const stdExcess = std(excessReturns);

    // Sharpe ratio
    if (stdExcess > 1e-12) {
      performanceMetrics["sharpe_ratio"] = Math.sqrt(252) * (meanExcess / stdExcess);
    } else {
      performanceMetrics["sharpe_ratio"] = 0;
    }

    // Sortino ratio
    const negativeReturns = excessReturns.filter((r) => r < 0);
    if (negativeReturns.length > 0) {
      const downsideStd = std(negativeReturns);
      if (downsideStd > 1e-12) {
        performanceMetrics["sortino_ratio"] = Math.sqrt(252) * (meanExcess / downsideStd);
      } else {
        performanceMetrics["sortino_ratio"] = meanExcess > 0 ? null : 0;
      }
    } else {
      performanceMetrics["sortino_ratio"] = meanExcess > 0 ? null : 0;
    }

    // Max drawdown
    let rollingMax = -Infinity;
    let minDrawdown = 0;
    let minDrawdownIdx = -1;
    for (let i = 0; i < values.length; i++) {
      const v = values[i]!;
      if (v > rollingMax) rollingMax = v;
      const dd = rollingMax !== 0 ? (v - rollingMax) / rollingMax : 0;
      if (dd < minDrawdown) {
        minDrawdown = dd;
        minDrawdownIdx = i;
      }
    }

    performanceMetrics["max_drawdown"] = minDrawdown * 100;
    if (minDrawdown < 0 && minDrawdownIdx >= 0) {
      const ddEntry = this.portfolioValues[minDrawdownIdx];
      const ddDate = ddEntry?.["Date"];
      performanceMetrics["max_drawdown_date"] =
        ddDate instanceof Date ? format(ddDate, "yyyy-MM-dd") : (ddDate as string) ?? null;
    } else {
      performanceMetrics["max_drawdown_date"] = null;
    }
  }

  // ─── runBacktestAsync ─────────────────────────────────────────────────────────

  async runBacktestAsync(progressCallback?: ProgressCallback): Promise<BacktestResult> {
    // Pre-fetch all data at the start
    await this.prefetchData();

    const dates = getBusinessDays(this.startDate, this.endDate);

    const performanceMetrics: Record<string, unknown> = {
      sharpe_ratio: 0,
      sortino_ratio: 0,
      max_drawdown: 0,
      long_short_ratio: 0,
      gross_exposure: 0,
      net_exposure: 0,
    };

    // Initialize portfolio values
    if (dates.length > 0) {
      this.portfolioValues = [{ Date: dates[0]!, "Portfolio Value": this.initialCapital }];
    } else {
      this.portfolioValues = [];
    }

    const backtestResults: BacktestDayResult[] = [];

    for (let i = 0; i < dates.length; i++) {
      // Yield control to avoid blocking the event loop
      await new Promise<void>((resolve) => setImmediate(resolve));

      const currentDate = dates[i]!;
      const currentDateStr = format(currentDate, "yyyy-MM-dd");
      const previousDateStr = format(subDays(currentDate, 1), "yyyy-MM-dd");
      const lookbackStart = format(subDays(currentDate, 30), "yyyy-MM-dd");

      if (lookbackStart === currentDateStr) continue;

      // Send progress callback
      if (progressCallback) {
        progressCallback({
          type: "progress",
          current_date: currentDateStr,
          progress: (i + 1) / dates.length,
          total_dates: dates.length,
          current_step: i + 1,
        });
      }

      // Get current prices
      let currentPrices: Record<string, number> = {};
      let missingData = false;

      try {
        for (const ticker of this.tickers) {
          try {
            const apiKeys = this.request["api_keys"] as Record<string, string> | undefined;
            const apiKey = apiKeys?.["FINANCIAL_DATASETS_API_KEY"];
            const priceData = await getPriceData(ticker, previousDateStr, currentDateStr, apiKey);
            if (!priceData.rows.length) {
              missingData = true;
              break;
            }
            const lastRow = priceData.rows[priceData.rows.length - 1]!;
            currentPrices[ticker] = lastRow.close;
          } catch {
            missingData = true;
            break;
          }
        }
      } catch {
        continue;
      }

      if (missingData) continue;

      // Run the LangGraph graph for this date
      let decisions: Record<string, Record<string, unknown>> = {};
      let analystSignals: Record<string, unknown> = {};

      try {
        const result = await runGraph(
          this.graph,
          this.portfolio,
          this.tickers,
          lookbackStart,
          currentDateStr,
          this.modelName,
          this.modelProvider,
          this.request
        );

        if (result && (result["messages"] as unknown[]  | undefined)?.length) {
          const messages = result["messages"] as Array<{ content: unknown }>;
          const lastContent = messages[messages.length - 1]?.content;
          const contentStr =
            typeof lastContent === "string" ? lastContent : JSON.stringify(lastContent);
          try {
            decisions = JSON.parse(contentStr) as Record<string, Record<string, unknown>>;
          } catch {
            decisions = {};
          }
          const data = result["data"] as Record<string, unknown> | undefined;
          analystSignals = (data?.["analyst_signals"] as Record<string, unknown>) ?? {};
        }
      } catch (err) {
        console.error(`Error running graph for ${currentDateStr}:`, err);
      }

      // Execute trades
      const executedTrades: Record<string, number> = {};
      for (const ticker of this.tickers) {
        const decision = decisions[ticker] ?? { action: "hold", quantity: 0 };
        const action = (decision["action"] as string) ?? "hold";
        const quantity = (decision["quantity"] as number) ?? 0;
        executedTrades[ticker] = this.executeTrade(ticker, action, quantity, currentPrices[ticker]!);
      }

      // Calculate portfolio value and exposures
      const totalValue = this.calculatePortfolioValue(currentPrices);
      const positions = this.portfolio["positions"] as Record<string, Record<string, number>>;

      const longExposure = this.tickers.reduce(
        (sum, t) => sum + (positions[t]!["long"] ?? 0) * (currentPrices[t] ?? 0),
        0
      );
      const shortExposure = this.tickers.reduce(
        (sum, t) => sum + (positions[t]!["short"] ?? 0) * (currentPrices[t] ?? 0),
        0
      );
      const grossExposure = longExposure + shortExposure;
      const netExposure = longExposure - shortExposure;
      const longShortRatio = shortExposure > 1e-9 ? longExposure / shortExposure : null;

      // Track portfolio values
      this.portfolioValues.push({
        Date: currentDate,
        "Portfolio Value": totalValue,
        "Long Exposure": longExposure,
        "Short Exposure": shortExposure,
        "Gross Exposure": grossExposure,
        "Net Exposure": netExposure,
        "Long/Short Ratio": longShortRatio,
      });

      const portfolioReturn = (totalValue / this.initialCapital - 1) * 100;

      // Update performance metrics if we have enough data
      if (this.portfolioValues.length > 2) {
        this._updatePerformanceMetrics(performanceMetrics);
      }

      // Build ticker details
      const tickerDetails = this.tickers.map((ticker) => {
        const tickerSignals: Record<string, unknown> = {};
        for (const [agentName, signals] of Object.entries(analystSignals)) {
          const agentSignals = signals as Record<string, unknown>;
          if (ticker in agentSignals) tickerSignals[agentName] = agentSignals[ticker];
        }

        const bullishCount = Object.values(tickerSignals).filter(
          (s) => (s as Record<string, string>)?.["signal"]?.toLowerCase() === "bullish"
        ).length;
        const bearishCount = Object.values(tickerSignals).filter(
          (s) => (s as Record<string, string>)?.["signal"]?.toLowerCase() === "bearish"
        ).length;
        const neutralCount = Object.values(tickerSignals).filter(
          (s) => (s as Record<string, string>)?.["signal"]?.toLowerCase() === "neutral"
        ).length;

        const pos = positions[ticker]!;
        const longVal = (pos["long"] ?? 0) * (currentPrices[ticker] ?? 0);
        const shortVal = (pos["short"] ?? 0) * (currentPrices[ticker] ?? 0);
        const netPositionValue = longVal - shortVal;

        return {
          ticker,
          action: decisions[ticker]?.["action"] ?? "hold",
          quantity: executedTrades[ticker] ?? 0,
          price: currentPrices[ticker] ?? 0,
          shares_owned: (pos["long"] ?? 0) - (pos["short"] ?? 0),
          long_shares: pos["long"] ?? 0,
          short_shares: pos["short"] ?? 0,
          position_value: netPositionValue,
          bullish_count: bullishCount,
          bearish_count: bearishCount,
          neutral_count: neutralCount,
        };
      });

      const dateResult: BacktestDayResult = {
        date: currentDateStr,
        portfolio_value: totalValue,
        cash: this.portfolio["cash"] as number,
        decisions: decisions as Record<string, unknown>,
        executed_trades: executedTrades,
        analyst_signals: analystSignals,
        current_prices: currentPrices,
        long_exposure: longExposure,
        short_exposure: shortExposure,
        gross_exposure: grossExposure,
        net_exposure: netExposure,
        long_short_ratio: longShortRatio,
        // Extra fields beyond the Zod schema are allowed at runtime
        ...(({
          portfolio_return: portfolioReturn,
          performance_metrics: { ...performanceMetrics },
          ticker_details: tickerDetails,
        }) as Record<string, unknown>),
      };

      backtestResults.push(dateResult);

      if (progressCallback) {
        progressCallback({ type: "backtest_result", data: dateResult as unknown as Record<string, unknown> });
      }
    }

    // Final metrics update
    if (this.portfolioValues.length > 1) {
      this._updatePerformanceMetrics(performanceMetrics);
    }

    // Final exposure from last result
    if (backtestResults.length > 0) {
      const last = backtestResults[backtestResults.length - 1]!;
      performanceMetrics["gross_exposure"] = last.gross_exposure;
      performanceMetrics["net_exposure"] = last.net_exposure;
      performanceMetrics["long_short_ratio"] = last.long_short_ratio ?? null;
    }

    return {
      results: backtestResults,
      performance_metrics: performanceMetrics as BacktestPerformanceMetrics,
      portfolio_values: this.portfolioValues,
      final_portfolio: this.portfolio,
    };
  }
}
