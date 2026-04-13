import type { FastifyInstance } from "fastify";
import { ollamaService } from "../services/ollamaService.js";

export async function ollamaRoutes(server: FastifyInstance): Promise<void> {
  // GET /ollama/status
  server.get("/ollama/status", async (_req, reply) => {
    const status = await ollamaService.checkOllamaStatus();
    return reply.send(status);
  });

  // POST /ollama/start
  server.post("/ollama/start", async (_req, reply) => {
    const result = await ollamaService.startServer();
    return reply.send(result);
  });

  // POST /ollama/stop
  server.post("/ollama/stop", async (_req, reply) => {
    const result = await ollamaService.stopServer();
    return reply.send(result);
  });

  // GET /ollama/models/recommended
  server.get("/ollama/models/recommended", async (_req, reply) => {
    const models = await ollamaService.getRecommendedModels();
    return reply.send({ models });
  });

  // POST /ollama/models/:modelName/download
  server.post<{ Params: { modelName: string } }>("/ollama/models/:modelName/download", async (req, reply) => {
    const result = await ollamaService.downloadModel(req.params.modelName);
    return reply.send(result);
  });

  // GET /ollama/models/:modelName/download/progress  (SSE streaming)
  server.get<{ Params: { modelName: string } }>("/ollama/models/:modelName/download/progress", async (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    for await (const chunk of ollamaService.downloadModelWithProgress(req.params.modelName)) {
      if (reply.raw.writableEnded) break;
      reply.raw.write(chunk);
    }

    reply.raw.end();
  });

  // DELETE /ollama/models/:modelName
  server.delete<{ Params: { modelName: string } }>("/ollama/models/:modelName", async (req, reply) => {
    const result = await ollamaService.deleteModel(req.params.modelName);
    return reply.send(result);
  });

  // DELETE /ollama/models/:modelName/cancel
  server.delete<{ Params: { modelName: string } }>("/ollama/models/:modelName/cancel", async (req, reply) => {
    const cancelled = ollamaService.cancelDownload(req.params.modelName);
    return reply.send({ success: cancelled });
  });

  // GET /ollama/models/:modelName/progress
  server.get<{ Params: { modelName: string } }>("/ollama/models/:modelName/progress", async (req, reply) => {
    const progress = ollamaService.getDownloadProgress(req.params.modelName);
    if (!progress) return reply.status(404).send({ message: "No active download for this model" });
    return reply.send(progress);
  });

  // GET /ollama/models/progress
  server.get("/ollama/models/progress", async (_req, reply) => {
    return reply.send(ollamaService.getAllDownloadProgress());
  });
}
