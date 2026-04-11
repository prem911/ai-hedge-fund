import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ─── hedge_fund_flows ────────────────────────────────────────────────────────
export const hedgeFundFlows = sqliteTable("hedge_fund_flows", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
  updatedAt: text("updated_at"),

  name: text("name").notNull(),
  description: text("description"),

  // React Flow state stored as JSON strings
  nodes: text("nodes").notNull(),
  edges: text("edges").notNull(),
  viewport: text("viewport"),
  data: text("data"),

  isTemplate: integer("is_template", { mode: "boolean" }).default(false),
  tags: text("tags"), // JSON array string
});

// ─── hedge_fund_flow_runs ─────────────────────────────────────────────────────
export const hedgeFundFlowRuns = sqliteTable("hedge_fund_flow_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  flowId: integer("flow_id")
    .notNull()
    .references(() => hedgeFundFlows.id),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
  updatedAt: text("updated_at"),

  status: text("status").notNull().default("IDLE"),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),

  tradingMode: text("trading_mode").notNull().default("one-time"),
  schedule: text("schedule"),
  duration: text("duration"),

  requestData: text("request_data"), // JSON string
  initialPortfolio: text("initial_portfolio"), // JSON string
  finalPortfolio: text("final_portfolio"), // JSON string
  results: text("results"), // JSON string
  errorMessage: text("error_message"),

  runNumber: integer("run_number").notNull().default(1),
});

// ─── hedge_fund_flow_run_cycles ───────────────────────────────────────────────
export const hedgeFundFlowRunCycles = sqliteTable("hedge_fund_flow_run_cycles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  flowRunId: integer("flow_run_id")
    .notNull()
    .references(() => hedgeFundFlowRuns.id),
  cycleNumber: integer("cycle_number").notNull(),

  createdAt: text("created_at").default(sql`(datetime('now'))`),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),

  analystSignals: text("analyst_signals"), // JSON string
  tradingDecisions: text("trading_decisions"), // JSON string
  executedTrades: text("executed_trades"), // JSON string
  portfolioSnapshot: text("portfolio_snapshot"), // JSON string
  performanceMetrics: text("performance_metrics"), // JSON string

  status: text("status").notNull().default("IN_PROGRESS"),
  errorMessage: text("error_message"),

  llmCallsCount: integer("llm_calls_count").default(0),
  apiCallsCount: integer("api_calls_count").default(0),
  estimatedCost: text("estimated_cost"),

  triggerReason: text("trigger_reason"),
  marketConditions: text("market_conditions"), // JSON string
});

// ─── api_keys ─────────────────────────────────────────────────────────────────
export const apiKeys = sqliteTable("api_keys", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
  updatedAt: text("updated_at"),

  provider: text("provider").notNull().unique(),
  keyValue: text("key_value").notNull(),
  isActive: integer("is_active", { mode: "boolean" }).default(true),
  description: text("description"),
  lastUsed: text("last_used"),
});

// ─── TypeScript types ─────────────────────────────────────────────────────────
export type HedgeFundFlow = typeof hedgeFundFlows.$inferSelect;
export type NewHedgeFundFlow = typeof hedgeFundFlows.$inferInsert;

export type HedgeFundFlowRun = typeof hedgeFundFlowRuns.$inferSelect;
export type NewHedgeFundFlowRun = typeof hedgeFundFlowRuns.$inferInsert;

export type HedgeFundFlowRunCycle = typeof hedgeFundFlowRunCycles.$inferSelect;
export type NewHedgeFundFlowRunCycle = typeof hedgeFundFlowRunCycles.$inferInsert;

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
