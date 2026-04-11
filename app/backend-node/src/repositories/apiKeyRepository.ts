import { eq, asc } from "drizzle-orm";
import { db } from "../db/connection.js";
import { apiKeys, type ApiKey } from "../db/schema.js";

function now(): string {
  return new Date().toISOString();
}

function rowToApiKey(row: ApiKey): Record<string, unknown> {
  return {
    id: row.id,
    provider: row.provider,
    key_value: row.keyValue,
    is_active: row.isActive ?? true,
    description: row.description,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    last_used: row.lastUsed,
  };
}

export async function createOrUpdateApiKey(params: {
  provider: string;
  key_value: string;
  description?: string | null;
  is_active?: boolean;
}): Promise<Record<string, unknown>> {
  const existing = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.provider, params.provider))
    .limit(1);

  if (existing[0]) {
    const rows = await db
      .update(apiKeys)
      .set({
        keyValue: params.key_value,
        description: params.description ?? existing[0].description,
        isActive: params.is_active ?? true,
        updatedAt: now(),
      })
      .where(eq(apiKeys.provider, params.provider))
      .returning();
    return rowToApiKey(rows[0]!);
  } else {
    const rows = await db
      .insert(apiKeys)
      .values({
        provider: params.provider,
        keyValue: params.key_value,
        description: params.description ?? null,
        isActive: params.is_active ?? true,
        createdAt: now(),
        updatedAt: now(),
      })
      .returning();
    return rowToApiKey(rows[0]!);
  }
}

export async function getAllApiKeys(includeInactive = false): Promise<Record<string, unknown>[]> {
  const rows = includeInactive
    ? await db.select().from(apiKeys).orderBy(asc(apiKeys.provider))
    : await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.isActive, true))
        .orderBy(asc(apiKeys.provider));
  return rows.map(rowToApiKey);
}

export async function getApiKeyByProvider(provider: string): Promise<Record<string, unknown> | null> {
  const rows = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.provider, provider))
    .limit(1);
  return rows[0] ? rowToApiKey(rows[0]) : null;
}

export async function updateApiKey(
  provider: string,
  params: {
    key_value?: string;
    description?: string | null;
    is_active?: boolean;
  }
): Promise<Record<string, unknown> | null> {
  const updates: Partial<typeof apiKeys.$inferInsert> = { updatedAt: now() };
  if (params.key_value !== undefined) updates.keyValue = params.key_value;
  if (params.description !== undefined) updates.description = params.description;
  if (params.is_active !== undefined) updates.isActive = params.is_active;

  const rows = await db
    .update(apiKeys)
    .set(updates)
    .where(eq(apiKeys.provider, provider))
    .returning();
  return rows[0] ? rowToApiKey(rows[0]) : null;
}

export async function deleteApiKey(provider: string): Promise<boolean> {
  const rows = await db.delete(apiKeys).where(eq(apiKeys.provider, provider)).returning();
  return rows.length > 0;
}

export async function deactivateApiKey(provider: string): Promise<boolean> {
  const rows = await db
    .update(apiKeys)
    .set({ isActive: false, updatedAt: now() })
    .where(eq(apiKeys.provider, provider))
    .returning();
  return rows.length > 0;
}

export async function updateLastUsed(provider: string): Promise<boolean> {
  const rows = await db
    .update(apiKeys)
    .set({ lastUsed: now() })
    .where(eq(apiKeys.provider, provider))
    .returning();
  return rows.length > 0;
}

export async function bulkCreateOrUpdate(
  apiKeysData: Array<{
    provider: string;
    key_value: string;
    description?: string | null;
    is_active?: boolean;
  }>
): Promise<Record<string, unknown>[]> {
  const results: Record<string, unknown>[] = [];
  for (const data of apiKeysData) {
    const result = await createOrUpdateApiKey(data);
    results.push(result);
  }
  return results;
}
