import { eq, desc, max, count, and } from "drizzle-orm";
import { db } from "../db/connection.js";
import { hedgeFundFlowRuns, type HedgeFundFlowRun } from "../db/schema.js";
import type { FlowRunStatus } from "../models/schemas.js";

function now(): string {
  return new Date().toISOString();
}

function serializeJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function deserializeJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function rowToFlowRun(row: HedgeFundFlowRun): Record<string, unknown> {
  return {
    id: row.id,
    flow_id: row.flowId,
    status: row.status,
    run_number: row.runNumber,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    started_at: row.startedAt,
    completed_at: row.completedAt,
    request_data: deserializeJson(row.requestData),
    initial_portfolio: deserializeJson(row.initialPortfolio),
    final_portfolio: deserializeJson(row.finalPortfolio),
    results: deserializeJson(row.results),
    error_message: row.errorMessage,
  };
}

async function getNextRunNumber(flowId: number): Promise<number> {
  const result = await db
    .select({ maxRun: max(hedgeFundFlowRuns.runNumber) })
    .from(hedgeFundFlowRuns)
    .where(eq(hedgeFundFlowRuns.flowId, flowId));
  return (result[0]?.maxRun ?? 0) + 1;
}

export async function createFlowRun(
  flowId: number,
  requestData?: Record<string, unknown> | null
): Promise<Record<string, unknown>> {
  const runNumber = await getNextRunNumber(flowId);
  const rows = await db
    .insert(hedgeFundFlowRuns)
    .values({
      flowId,
      requestData: serializeJson(requestData),
      runNumber,
      status: "IDLE",
      createdAt: now(),
      updatedAt: now(),
    })
    .returning();
  return rowToFlowRun(rows[0]!);
}

export async function getFlowRunsByFlowId(
  flowId: number,
  limit = 50,
  offset = 0
): Promise<Record<string, unknown>[]> {
  const rows = await db
    .select()
    .from(hedgeFundFlowRuns)
    .where(eq(hedgeFundFlowRuns.flowId, flowId))
    .orderBy(desc(hedgeFundFlowRuns.createdAt))
    .limit(limit)
    .offset(offset);
  return rows.map(rowToFlowRun);
}

export async function getFlowRunById(runId: number): Promise<Record<string, unknown> | null> {
  const rows = await db
    .select()
    .from(hedgeFundFlowRuns)
    .where(eq(hedgeFundFlowRuns.id, runId))
    .limit(1);
  return rows[0] ? rowToFlowRun(rows[0]) : null;
}

export async function getActiveFlowRun(flowId: number): Promise<Record<string, unknown> | null> {
  const rows = await db
    .select()
    .from(hedgeFundFlowRuns)
    .where(and(eq(hedgeFundFlowRuns.flowId, flowId), eq(hedgeFundFlowRuns.status, "IN_PROGRESS")))
    .limit(1);
  return rows[0] ? rowToFlowRun(rows[0]) : null;
}

export async function getLatestFlowRun(flowId: number): Promise<Record<string, unknown> | null> {
  const rows = await db
    .select()
    .from(hedgeFundFlowRuns)
    .where(eq(hedgeFundFlowRuns.flowId, flowId))
    .orderBy(desc(hedgeFundFlowRuns.createdAt))
    .limit(1);
  return rows[0] ? rowToFlowRun(rows[0]) : null;
}

export async function updateFlowRun(
  runId: number,
  params: {
    status?: FlowRunStatus;
    results?: Record<string, unknown> | null;
    error_message?: string | null;
  }
): Promise<Record<string, unknown> | null> {
  const existing = await getFlowRunById(runId);
  if (!existing) return null;

  const updates: Partial<typeof hedgeFundFlowRuns.$inferInsert> = { updatedAt: now() };

  if (params.status !== undefined) {
    updates.status = params.status;
    if (params.status === "IN_PROGRESS" && !existing["started_at"]) {
      updates.startedAt = now();
    } else if (
      (params.status === "COMPLETE" || params.status === "ERROR") &&
      !existing["completed_at"]
    ) {
      updates.completedAt = now();
    }
  }
  if (params.results !== undefined) updates.results = serializeJson(params.results);
  if (params.error_message !== undefined) updates.errorMessage = params.error_message;

  const rows = await db
    .update(hedgeFundFlowRuns)
    .set(updates)
    .where(eq(hedgeFundFlowRuns.id, runId))
    .returning();
  return rows[0] ? rowToFlowRun(rows[0]) : null;
}

export async function deleteFlowRun(runId: number): Promise<boolean> {
  const rows = await db
    .delete(hedgeFundFlowRuns)
    .where(eq(hedgeFundFlowRuns.id, runId))
    .returning();
  return rows.length > 0;
}

export async function deleteFlowRunsByFlowId(flowId: number): Promise<number> {
  const rows = await db
    .delete(hedgeFundFlowRuns)
    .where(eq(hedgeFundFlowRuns.flowId, flowId))
    .returning();
  return rows.length;
}

export async function getFlowRunCount(flowId: number): Promise<number> {
  const result = await db
    .select({ count: count() })
    .from(hedgeFundFlowRuns)
    .where(eq(hedgeFundFlowRuns.flowId, flowId));
  return result[0]?.count ?? 0;
}
