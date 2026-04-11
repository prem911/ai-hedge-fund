import type { FastifyInstance } from "fastify";
import {
  ApiKeyCreateRequestSchema,
  ApiKeyUpdateRequestSchema,
  ApiKeyBulkUpdateRequestSchema,
} from "../models/schemas.js";
import * as apiKeyRepo from "../repositories/apiKeyRepository.js";

export async function apiKeyRoutes(server: FastifyInstance): Promise<void> {
  // POST /api-keys/
  server.post("/api-keys/", async (request, reply) => {
    const parsed = ApiKeyCreateRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ message: "Invalid request", error: parsed.error.message });
    const key = await apiKeyRepo.createOrUpdateApiKey(parsed.data);
    return reply.status(201).send(key);
  });

  // GET /api-keys/
  server.get("/api-keys/", async (_request, reply) => {
    const keys = await apiKeyRepo.getAllApiKeys(true);
    // Return summary (without key_value)
    const summaries = keys.map((k) => ({
      id: k["id"],
      provider: k["provider"],
      is_active: k["is_active"],
      description: k["description"],
      created_at: k["created_at"],
      updated_at: k["updated_at"],
      last_used: k["last_used"],
      has_key: Boolean(k["key_value"]),
    }));
    return reply.send(summaries);
  });

  // GET /api-keys/:provider
  server.get<{ Params: { provider: string } }>("/api-keys/:provider", async (request, reply) => {
    const key = await apiKeyRepo.getApiKeyByProvider(request.params.provider);
    if (!key) return reply.status(404).send({ message: "API key not found" });
    return reply.send(key);
  });

  // PUT /api-keys/:provider
  server.put<{ Params: { provider: string } }>("/api-keys/:provider", async (request, reply) => {
    const parsed = ApiKeyUpdateRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ message: "Invalid request", error: parsed.error.message });
    const updated = await apiKeyRepo.updateApiKey(request.params.provider, parsed.data);
    if (!updated) return reply.status(404).send({ message: "API key not found" });
    return reply.send(updated);
  });

  // DELETE /api-keys/:provider
  server.delete<{ Params: { provider: string } }>("/api-keys/:provider", async (request, reply) => {
    const deleted = await apiKeyRepo.deleteApiKey(request.params.provider);
    if (!deleted) return reply.status(404).send({ message: "API key not found" });
    return reply.status(204).send();
  });

  // POST /api-keys/bulk
  server.post("/api-keys/bulk", async (request, reply) => {
    const parsed = ApiKeyBulkUpdateRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ message: "Invalid request", error: parsed.error.message });
    const results = await apiKeyRepo.bulkCreateOrUpdate(parsed.data.api_keys);
    return reply.send(results);
  });

  // PATCH /api-keys/:provider/deactivate
  server.patch<{ Params: { provider: string } }>("/api-keys/:provider/deactivate", async (request, reply) => {
    const success = await apiKeyRepo.deactivateApiKey(request.params.provider);
    if (!success) return reply.status(404).send({ message: "API key not found" });
    return reply.send({ success: true });
  });

  // PATCH /api-keys/:provider/last-used
  server.patch<{ Params: { provider: string } }>("/api-keys/:provider/last-used", async (request, reply) => {
    const success = await apiKeyRepo.updateLastUsed(request.params.provider);
    if (!success) return reply.status(404).send({ message: "API key not found" });
    return reply.send({ success: true });
  });
}
