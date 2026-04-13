/**
 * BacktestService scaffold — Phase 2.
 *
 * A full implementation would replicate app/backend/services/backtest_service.py.
 * The core logic (trade execution, position tracking, performance metrics) requires
 * the full set of analyst agents (Phase 3+). This scaffold provides the structure
 * and basic types; the run_backtest_async method is a placeholder.
 */

import type { BacktestRequest, BacktestDayResult, BacktestPerformanceMetrics } from "../models/schemas.js";
import { runGraph, createGraph } from "./graphService.js";

export interface BacktestResult {
  results: BacktestDayResult[];
  performance_metrics: BacktestPerformanceMetrics;
  final_portfolio: Record<string, unknown>;
}

export type ProgressCallback = (update: Record<string, unknown>) => void;

export class BacktestService {
  private graph: ReturnType<typeof createGraph>;
  private portfolio: Record<string, unknown>;
  private tickers: string[];
  private startDate: string;
  private endDate: string;
  private initialCapital: number;
  private modelName: string;
  private modelProvider: string;
  private request: unknown;

  constructor(params: {
    graph: ReturnType<typeof createGraph>;
    portfolio: Record<string, unknown>;
    tickers: string[];
    startDate: string;
    endDate: string;
    initialCapital: number;
    modelName?: string;
    modelProvider?: string;
    request?: unknown;
  }) {
    this.graph = params.graph;
    this.portfolio = params.portfolio;
    this.tickers = params.tickers;
    this.startDate = params.startDate;
    this.endDate = params.endDate;
    this.initialCapital = params.initialCapital;
    this.modelName = params.modelName ?? "gpt-4.1";
    this.modelProvider = params.modelProvider ?? "OpenAI";
    this.request = params.request;
  }

  async runBacktestAsync(progressCallback?: ProgressCallback): Promise<BacktestResult> {
    // TODO: Implement full day-by-day backtest loop (Phase 3+)
    // For now, run a single pass over the full date range
    progressCallback?.({
      type: "progress",
      current_date: this.startDate,
      current_step: 1,
      total_dates: 1,
    });

    const result = await runGraph(
      this.graph,
      this.portfolio,
      this.tickers,
      this.startDate,
      this.endDate,
      this.modelName,
      this.modelProvider,
      this.request
    );

    const messages = (result["messages"] as Array<{ content: unknown }> | undefined) ?? [];
    const lastMsg = messages[messages.length - 1];
    const decisions =
      typeof lastMsg?.content === "string"
        ? (() => {
            try {
              return JSON.parse(lastMsg.content) as Record<string, unknown>;
            } catch {
              return {};
            }
          })()
        : {};

    const dayResult: BacktestDayResult = {
      date: this.endDate,
      portfolio_value: this.initialCapital,
      cash: (this.portfolio["cash"] as number) ?? this.initialCapital,
      decisions: decisions as Record<string, unknown>,
      executed_trades: {},
      analyst_signals: (result["data"] as Record<string, unknown>)?.["analyst_signals"] as Record<string, unknown> ?? {},
      current_prices: {},
      long_exposure: 0,
      short_exposure: 0,
      gross_exposure: 0,
      net_exposure: 0,
    };

    progressCallback?.({
      type: "backtest_result",
      data: dayResult,
    });

    return {
      results: [dayResult],
      performance_metrics: {},
      final_portfolio: this.portfolio,
    };
  }
}
