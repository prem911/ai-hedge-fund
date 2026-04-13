import type { FastifyInstance } from "fastify";
import { ollamaService } from "../services/ollamaService.js";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadModelsJson(filename: string): unknown[] {
  const filePath = path.resolve(__dirname, "../../../src/llm", filename);
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown[];
    }
  } catch {
    // Ignore read errors
  }
  return [];
}

export async function languageModelRoutes(server: FastifyInstance): Promise<void> {
  // GET /language-models/
  server.get("/language-models/", async (_request, reply) => {
    try {
      const apiModels = loadModelsJson("api_models.json") as Array<{
        display_name: string;
        model_name: string;
        provider: string;
      }>;

      // Add available Ollama models
      const ollamaModels = await ollamaService.getAvailableModels();

      return reply.send({ models: [...apiModels, ...ollamaModels] });
    } catch (err) {
      return reply.status(500).send({ message: "Failed to retrieve models", error: String(err) });
    }
  });

  // GET /language-models/providers
  server.get("/language-models/providers", async (_request, reply) => {
    try {
      const apiModels = loadModelsJson("api_models.json") as Array<{
        display_name: string;
        model_name: string;
        provider: string;
      }>;

      const providers: Record<string, { name: string; models: Array<{ display_name: string; model_name: string }> }> = {};
      for (const model of apiModels) {
        if (!providers[model.provider]) {
          providers[model.provider] = { name: model.provider, models: [] };
        }
        providers[model.provider]!.models.push({
          display_name: model.display_name,
          model_name: model.model_name,
        });
      }

      return reply.send({ providers: Object.values(providers) });
    } catch (err) {
      return reply.status(500).send({ message: "Failed to retrieve providers", error: String(err) });
    }
  });
}
