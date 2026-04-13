import type { FastifyInstance } from "fastify";
import {
  HedgeFundRequestSchema,
  BacktestRequestSchema,
  getStartDate,
} from "../models/schemas.js";
import {
  createStartEvent,
  createProgressUpdateEvent,
  createErrorEvent,
  createCompleteEvent,
} from "../models/events.js";
import { createGraph, runGraph, parseHedgeFundResponse, getAgentsList } from "../services/graphService.js";
import { createPortfolio } from "../services/portfolioService.js";
import { ApiKeyService } from "../services/apiKeyService.js";
import { BacktestService, type BacktestProgressUpdate } from "../services/backtestService.js";

export async function hedgeFundRoutes(server: FastifyInstance): Promise<void> {
  // ─── POST /hedge-fund/run ────────────────────────────────────────────────────
  server.post("/hedge-fund/run", async (request, reply) => {
    const parseResult = HedgeFundRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ message: "Invalid request", error: parseResult.error.message });
    }

    const requestData = parseResult.data;

    // Hydrate API keys from DB if not provided
    if (!requestData.api_keys) {
      const svc = new ApiKeyService();
      requestData.api_keys = await svc.getApiKeysDict();
    }

    const modelProvider =
      typeof requestData.model_provider === "string"
        ? requestData.model_provider
        : String(requestData.model_provider ?? "OpenAI");

    const portfolio = createPortfolio(
      requestData.initial_cash,
      requestData.margin_requirement,
      requestData.tickers,
      requestData.portfolio_positions ?? null
    );

    const graph = createGraph(requestData.graph_nodes, requestData.graph_edges);

    // SSE headers
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    let aborted = false;
    request.raw.on("close", () => { aborted = true; });

    // Send start event
    reply.raw.write(createStartEvent().toSSE());

    try {
      const runPromise = runGraph(
        graph,
        portfolio,
        requestData.tickers,
        getStartDate(requestData),
        requestData.end_date,
        requestData.model_name ?? "gpt-4.1",
        modelProvider,
        requestData
      );

      const result = await runPromise;

      if (aborted) {
        reply.raw.end();
        return;
      }

      const messages = (result["messages"] as Array<{ content: unknown }> | undefined) ?? [];
      if (!messages.length) {
        reply.raw.write(createErrorEvent("Failed to generate hedge fund decisions").toSSE());
        reply.raw.end();
        return;
      }

      const lastContent = messages[messages.length - 1]?.content;
      const contentStr = typeof lastContent === "string" ? lastContent : JSON.stringify(lastContent);
      const decisions = parseHedgeFundResponse(contentStr);

      const data = result["data"] as Record<string, unknown> | undefined;
      reply.raw.write(
        createCompleteEvent({
          decisions: decisions ?? {},
          analyst_signals: (data?.["analyst_signals"] as Record<string, unknown>) ?? {},
          current_prices: (data?.["current_prices"] as Record<string, unknown>) ?? {},
        }).toSSE()
      );
    } catch (err) {
      reply.raw.write(createErrorEvent(`An error occurred: ${String(err)}`).toSSE());
    }

    reply.raw.end();
  });

  // ─── POST /hedge-fund/backtest ────────────────────────────────────────────────
  server.post("/hedge-fund/backtest", async (request, reply) => {
    const parseResult = BacktestRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ message: "Invalid request", error: parseResult.error.message });
    }

    const requestData = parseResult.data;

    if (!requestData.api_keys) {
      const svc = new ApiKeyService();
      requestData.api_keys = await svc.getApiKeysDict();
    }

    const modelProvider =
      typeof requestData.model_provider === "string"
        ? requestData.model_provider
        : String(requestData.model_provider ?? "OpenAI");

    const portfolio = createPortfolio(
      requestData.initial_capital,
      requestData.margin_requirement,
      requestData.tickers,
      requestData.portfolio_positions ?? null
    );

    const graph = createGraph(requestData.graph_nodes, requestData.graph_edges);
    const backtestService = new BacktestService({
      graph,
      portfolio,
      tickers: requestData.tickers,
      startDate: requestData.start_date,
      endDate: requestData.end_date,
      initialCapital: requestData.initial_capital,
      modelName: requestData.model_name ?? "gpt-4.1",
      modelProvider,
      request: requestData,
    });

    // SSE headers
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    let aborted = false;
    request.raw.on("close", () => { aborted = true; });

    reply.raw.write(createStartEvent().toSSE());

    try {
      const result = await backtestService.runBacktestAsync((update: BacktestProgressUpdate) => {
        if (aborted) return;
        if (update.type === "progress") {
          reply.raw.write(
            createProgressUpdateEvent("backtest", `Processing ${update.current_date} (${update.current_step}/${update.total_dates})`).toSSE()
          );
        } else if (update.type === "backtest_result") {
          const dayData = update.data as Record<string, unknown>;
          reply.raw.write(
            createProgressUpdateEvent("backtest", `Completed ${dayData["date"]} - Portfolio: $${Number(dayData["portfolio_value"]).toLocaleString()}`, {
              analysis: JSON.stringify(dayData),
            }).toSSE()
          );
        }
      });

      if (!aborted) {
        reply.raw.write(
          createCompleteEvent({
            performance_metrics: result.performance_metrics,
            final_portfolio: result.final_portfolio,
            total_days: result.results.length,
          }).toSSE()
        );
      }
    } catch (err) {
      reply.raw.write(createErrorEvent(`Backtest error: ${String(err)}`).toSSE());
    }

    reply.raw.end();
  });

  // ─── GET /hedge-fund/agents ────────────────────────────────────────────────
  server.get("/hedge-fund/agents", async (_request, reply) => {
    try {
      return reply.send({ agents: getAgentsList() });
    } catch (err) {
      return reply.status(500).send({ message: "Failed to retrieve agents", error: String(err) });
    }
  });
}
