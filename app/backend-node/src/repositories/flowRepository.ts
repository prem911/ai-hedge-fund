import { eq, ilike, desc, isNull, or } from "drizzle-orm";
import { db } from "../db/connection.js";
import { hedgeFundFlows, type HedgeFundFlow, type NewHedgeFundFlow } from "../db/schema.js";

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

// ─── Helpers to convert DB row → plain object with parsed JSON ────────────────
export function rowToFlow(row: HedgeFundFlow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    nodes: deserializeJson(row.nodes) ?? [],
    edges: deserializeJson(row.edges) ?? [],
    viewport: deserializeJson(row.viewport),
    data: deserializeJson(row.data),
    is_template: row.isTemplate ?? false,
    tags: deserializeJson<string[]>(row.tags),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

// ─── FlowRepository ────────────────────────────────────────────────────────────
export async function createFlow(params: {
  name: string;
  nodes: unknown;
  edges: unknown;
  description?: string | null;
  viewport?: unknown;
  data?: unknown;
  is_template?: boolean;
  tags?: string[] | null;
}): Promise<Record<string, unknown>> {
  const row = await db
    .insert(hedgeFundFlows)
    .values({
      name: params.name,
      description: params.description ?? null,
      nodes: serializeJson(params.nodes) ?? "[]",
      edges: serializeJson(params.edges) ?? "[]",
      viewport: serializeJson(params.viewport),
      data: serializeJson(params.data),
      isTemplate: params.is_template ?? false,
      tags: serializeJson(params.tags),
      createdAt: now(),
      updatedAt: now(),
    })
    .returning();
  return rowToFlow(row[0]!);
}

export async function getAllFlows(includeTemplates = true): Promise<Record<string, unknown>[]> {
  const rows = includeTemplates
    ? await db.select().from(hedgeFundFlows).orderBy(desc(hedgeFundFlows.updatedAt))
    : await db
        .select()
        .from(hedgeFundFlows)
        .where(eq(hedgeFundFlows.isTemplate, false))
        .orderBy(desc(hedgeFundFlows.updatedAt));
  return rows.map(rowToFlow);
}

export async function getFlowById(flowId: number): Promise<Record<string, unknown> | null> {
  const rows = await db.select().from(hedgeFundFlows).where(eq(hedgeFundFlows.id, flowId)).limit(1);
  return rows[0] ? rowToFlow(rows[0]) : null;
}

export async function getFlowsByName(name: string): Promise<Record<string, unknown>[]> {
  const rows = await db
    .select()
    .from(hedgeFundFlows)
    .where(ilike(hedgeFundFlows.name, `%${name}%`))
    .orderBy(desc(hedgeFundFlows.updatedAt));
  return rows.map(rowToFlow);
}

export async function updateFlow(
  flowId: number,
  params: {
    name?: string;
    description?: string | null;
    nodes?: unknown;
    edges?: unknown;
    viewport?: unknown;
    data?: unknown;
    is_template?: boolean;
    tags?: string[] | null;
  }
): Promise<Record<string, unknown> | null> {
  const existing = await getFlowById(flowId);
  if (!existing) return null;

  const updates: Partial<NewHedgeFundFlow> = { updatedAt: now() };
  if (params.name !== undefined) updates.name = params.name;
  if (params.description !== undefined) updates.description = params.description;
  if (params.nodes !== undefined) updates.nodes = serializeJson(params.nodes) ?? "[]";
  if (params.edges !== undefined) updates.edges = serializeJson(params.edges) ?? "[]";
  if (params.viewport !== undefined) updates.viewport = serializeJson(params.viewport);
  if (params.data !== undefined) updates.data = serializeJson(params.data);
  if (params.is_template !== undefined) updates.isTemplate = params.is_template;
  if (params.tags !== undefined) updates.tags = serializeJson(params.tags);

  const rows = await db.update(hedgeFundFlows).set(updates).where(eq(hedgeFundFlows.id, flowId)).returning();
  return rows[0] ? rowToFlow(rows[0]) : null;
}

export async function deleteFlow(flowId: number): Promise<boolean> {
  const rows = await db.delete(hedgeFundFlows).where(eq(hedgeFundFlows.id, flowId)).returning();
  return rows.length > 0;
}

export async function duplicateFlow(
  flowId: number,
  newName?: string
): Promise<Record<string, unknown> | null> {
  const original = await getFlowById(flowId);
  if (!original) return null;

  const copyName = newName ?? `${original["name"]} (Copy)`;
  return createFlow({
    name: copyName as string,
    description: original["description"] as string | null,
    nodes: original["nodes"],
    edges: original["edges"],
    viewport: original["viewport"],
    data: original["data"],
    is_template: false,
    tags: original["tags"] as string[] | null,
  });
}
