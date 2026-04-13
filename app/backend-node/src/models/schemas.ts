import { z } from "zod";
import { subDays, format } from "date-fns";

// ─── FlowRunStatus ─────────────────────────────────────────────────────────────
export const FlowRunStatusEnum = z.enum(["IDLE", "IN_PROGRESS", "COMPLETE", "ERROR"]);
export type FlowRunStatus = z.infer<typeof FlowRunStatusEnum>;

// ─── ModelProvider ─────────────────────────────────────────────────────────────
export const ModelProviderEnum = z.enum([
  "OpenAI",
  "Anthropic",
  "Groq",
  "Google",
  "Ollama",
  "DeepSeek",
  "xAI",
  "GigaChat",
  "Azure OpenAI",
  "OpenRouter",
  "Alibaba",
  "Meta",
  "Mistral",
]);
export type ModelProvider = z.infer<typeof ModelProviderEnum>;

// ─── AgentModelConfig ──────────────────────────────────────────────────────────
export const AgentModelConfigSchema = z.object({
  agent_id: z.string(),
  model_name: z.string().optional().nullable(),
  model_provider: ModelProviderEnum.optional().nullable(),
});
export type AgentModelConfig = z.infer<typeof AgentModelConfigSchema>;

// ─── PortfolioPosition ─────────────────────────────────────────────────────────
export const PortfolioPositionSchema = z.object({
  ticker: z.string(),
  quantity: z.number(),
  trade_price: z.number().refine((v) => v > 0, { message: "Trade price must be positive!" }),
});
export type PortfolioPosition = z.infer<typeof PortfolioPositionSchema>;

// ─── GraphNode / GraphEdge ────────────────────────────────────────────────────
export const GraphNodeSchema = z.object({
  id: z.string(),
  type: z.string().optional().nullable(),
  data: z.record(z.any()).optional().nullable(),
  position: z.record(z.any()).optional().nullable(),
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const GraphEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  type: z.string().optional().nullable(),
  data: z.record(z.any()).optional().nullable(),
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

// ─── HedgeFundResponse / ErrorResponse ───────────────────────────────────────
export const HedgeFundResponseSchema = z.object({
  decisions: z.record(z.any()),
  analyst_signals: z.record(z.any()),
});
export type HedgeFundResponse = z.infer<typeof HedgeFundResponseSchema>;

export const ErrorResponseSchema = z.object({
  message: z.string(),
  error: z.string().optional().nullable(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

// ─── BaseHedgeFundRequest ─────────────────────────────────────────────────────
export const BaseHedgeFundRequestSchema = z.object({
  tickers: z.array(z.string()),
  graph_nodes: z.array(GraphNodeSchema),
  graph_edges: z.array(GraphEdgeSchema),
  agent_models: z.array(AgentModelConfigSchema).optional().nullable(),
  model_name: z.string().optional().nullable().default("gpt-4.1"),
  model_provider: ModelProviderEnum.optional().nullable().default("OpenAI"),
  margin_requirement: z.number().default(0.0),
  portfolio_positions: z.array(PortfolioPositionSchema).optional().nullable(),
  api_keys: z.record(z.string()).optional().nullable(),
});
export type BaseHedgeFundRequest = z.infer<typeof BaseHedgeFundRequestSchema>;

/** Extract agent IDs from graph structure */
export function getAgentIds(req: BaseHedgeFundRequest): string[] {
  return req.graph_nodes.map((n) => n.id);
}

/** Get model configuration for a specific agent */
export function getAgentModelConfig(
  req: BaseHedgeFundRequest,
  agentId: string,
  extractBaseAgentKey: (id: string) => string
): [string, string] {
  if (req.agent_models && req.agent_models.length > 0) {
    const baseAgentKey = extractBaseAgentKey(agentId);
    for (const config of req.agent_models) {
      const configBaseKey = extractBaseAgentKey(config.agent_id);
      if (config.agent_id === agentId || configBaseKey === baseAgentKey) {
        return [
          config.model_name ?? req.model_name ?? "gpt-4.1",
          config.model_provider ?? req.model_provider ?? "OpenAI",
        ];
      }
    }
  }
  return [req.model_name ?? "gpt-4.1", req.model_provider ?? "OpenAI"];
}

// ─── BacktestRequest ──────────────────────────────────────────────────────────
export const BacktestRequestSchema = BaseHedgeFundRequestSchema.extend({
  start_date: z.string(),
  end_date: z.string(),
  initial_capital: z.number().default(100000.0),
});
export type BacktestRequest = z.infer<typeof BacktestRequestSchema>;

export const BacktestDayResultSchema = z.object({
  date: z.string(),
  portfolio_value: z.number(),
  cash: z.number(),
  decisions: z.record(z.any()),
  executed_trades: z.record(z.number()),
  analyst_signals: z.record(z.any()),
  current_prices: z.record(z.number()),
  long_exposure: z.number(),
  short_exposure: z.number(),
  gross_exposure: z.number(),
  net_exposure: z.number(),
  long_short_ratio: z.number().optional().nullable(),
});
export type BacktestDayResult = z.infer<typeof BacktestDayResultSchema>;

export const BacktestPerformanceMetricsSchema = z.object({
  sharpe_ratio: z.number().optional().nullable(),
  sortino_ratio: z.number().optional().nullable(),
  max_drawdown: z.number().optional().nullable(),
  max_drawdown_date: z.string().optional().nullable(),
  long_short_ratio: z.number().optional().nullable(),
  gross_exposure: z.number().optional().nullable(),
  net_exposure: z.number().optional().nullable(),
});
export type BacktestPerformanceMetrics = z.infer<typeof BacktestPerformanceMetricsSchema>;

export const BacktestResponseSchema = z.object({
  results: z.array(BacktestDayResultSchema),
  performance_metrics: BacktestPerformanceMetricsSchema,
  final_portfolio: z.record(z.any()),
});
export type BacktestResponse = z.infer<typeof BacktestResponseSchema>;

// ─── HedgeFundRequest ─────────────────────────────────────────────────────────
export const HedgeFundRequestSchema = BaseHedgeFundRequestSchema.extend({
  end_date: z.string().default(() => format(new Date(), "yyyy-MM-dd")),
  start_date: z.string().optional().nullable(),
  initial_cash: z.number().default(100000.0),
});
export type HedgeFundRequest = z.infer<typeof HedgeFundRequestSchema>;

/** Calculate start date if not provided (90 days before end_date) */
export function getStartDate(req: HedgeFundRequest): string {
  if (req.start_date) return req.start_date;
  const end = new Date(req.end_date);
  return format(subDays(end, 90), "yyyy-MM-dd");
}

// ─── Flow schemas ─────────────────────────────────────────────────────────────
export const FlowCreateRequestSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().optional().nullable(),
  nodes: z.array(z.record(z.any())),
  edges: z.array(z.record(z.any())),
  viewport: z.record(z.any()).optional().nullable(),
  data: z.record(z.any()).optional().nullable(),
  is_template: z.boolean().default(false),
  tags: z.array(z.string()).optional().nullable(),
});
export type FlowCreateRequest = z.infer<typeof FlowCreateRequestSchema>;

export const FlowUpdateRequestSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().optional().nullable(),
  nodes: z.array(z.record(z.any())).optional(),
  edges: z.array(z.record(z.any())).optional(),
  viewport: z.record(z.any()).optional().nullable(),
  data: z.record(z.any()).optional().nullable(),
  is_template: z.boolean().optional(),
  tags: z.array(z.string()).optional().nullable(),
});
export type FlowUpdateRequest = z.infer<typeof FlowUpdateRequestSchema>;

export const FlowResponseSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string().nullable(),
  nodes: z.array(z.record(z.any())),
  edges: z.array(z.record(z.any())),
  viewport: z.record(z.any()).nullable(),
  data: z.record(z.any()).nullable(),
  is_template: z.boolean(),
  tags: z.array(z.string()).nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
});
export type FlowResponse = z.infer<typeof FlowResponseSchema>;

export const FlowSummaryResponseSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string().nullable(),
  is_template: z.boolean(),
  tags: z.array(z.string()).nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
});
export type FlowSummaryResponse = z.infer<typeof FlowSummaryResponseSchema>;

// ─── FlowRun schemas ──────────────────────────────────────────────────────────
export const FlowRunCreateRequestSchema = z.object({
  request_data: z.record(z.any()).optional().nullable(),
});
export type FlowRunCreateRequest = z.infer<typeof FlowRunCreateRequestSchema>;

export const FlowRunUpdateRequestSchema = z.object({
  status: FlowRunStatusEnum.optional(),
  results: z.record(z.any()).optional().nullable(),
  error_message: z.string().optional().nullable(),
});
export type FlowRunUpdateRequest = z.infer<typeof FlowRunUpdateRequestSchema>;

export const FlowRunResponseSchema = z.object({
  id: z.number(),
  flow_id: z.number(),
  status: FlowRunStatusEnum,
  run_number: z.number(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  request_data: z.record(z.any()).nullable(),
  results: z.record(z.any()).nullable(),
  error_message: z.string().nullable(),
});
export type FlowRunResponse = z.infer<typeof FlowRunResponseSchema>;

export const FlowRunSummaryResponseSchema = z.object({
  id: z.number(),
  flow_id: z.number(),
  status: FlowRunStatusEnum,
  run_number: z.number(),
  created_at: z.string().nullable(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  error_message: z.string().nullable(),
});
export type FlowRunSummaryResponse = z.infer<typeof FlowRunSummaryResponseSchema>;

// ─── ApiKey schemas ────────────────────────────────────────────────────────────
export const ApiKeyCreateRequestSchema = z.object({
  provider: z.string().min(1).max(100),
  key_value: z.string().min(1),
  description: z.string().optional().nullable(),
  is_active: z.boolean().default(true),
});
export type ApiKeyCreateRequest = z.infer<typeof ApiKeyCreateRequestSchema>;

export const ApiKeyUpdateRequestSchema = z.object({
  key_value: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  is_active: z.boolean().optional(),
});
export type ApiKeyUpdateRequest = z.infer<typeof ApiKeyUpdateRequestSchema>;

export const ApiKeyResponseSchema = z.object({
  id: z.number(),
  provider: z.string(),
  key_value: z.string(),
  is_active: z.boolean(),
  description: z.string().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  last_used: z.string().nullable(),
});
export type ApiKeyResponse = z.infer<typeof ApiKeyResponseSchema>;

export const ApiKeySummaryResponseSchema = z.object({
  id: z.number(),
  provider: z.string(),
  is_active: z.boolean(),
  description: z.string().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  last_used: z.string().nullable(),
  has_key: z.boolean().default(true),
});
export type ApiKeySummaryResponse = z.infer<typeof ApiKeySummaryResponseSchema>;

export const ApiKeyBulkUpdateRequestSchema = z.object({
  api_keys: z.array(ApiKeyCreateRequestSchema),
});
export type ApiKeyBulkUpdateRequest = z.infer<typeof ApiKeyBulkUpdateRequestSchema>;
