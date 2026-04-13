import type { FastifyInstance } from "fastify";
import { healthRoutes } from "./health.js";
import { hedgeFundRoutes } from "./hedgeFund.js";
import { flowRoutes } from "./flows.js";
import { flowRunRoutes } from "./flowRuns.js";
import { apiKeyRoutes } from "./apiKeys.js";
import { ollamaRoutes } from "./ollama.js";
import { languageModelRoutes } from "./languageModels.js";
import { storageRoutes } from "./storage.js";

export async function registerRoutes(server: FastifyInstance): Promise<void> {
  await server.register(healthRoutes);
  await server.register(hedgeFundRoutes);
  await server.register(flowRoutes);
  await server.register(flowRunRoutes);
  await server.register(apiKeyRoutes);
  await server.register(ollamaRoutes);
  await server.register(languageModelRoutes);
  await server.register(storageRoutes);
}
