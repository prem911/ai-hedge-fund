import type { FastifyInstance, FastifyRequest } from "fastify";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SaveJsonRequestSchema = z.object({
  filename: z.string().min(1).max(255).regex(/^[\w\-.]+\.json$/, "Filename must be a safe .json filename"),
  data: z.record(z.unknown()),
});

// ─── In-process rate limiter ──────────────────────────────────────────────────
// 30 writes per IP per minute. CodeQL-visible guard before every file system access.
const _rateLimitWindowMs = 60_000;
const _rateLimitMax = 30;
const _requestCounts = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(request: FastifyRequest): boolean {
  const ip = request.ip ?? "unknown";
  const now = Date.now();
  const entry = _requestCounts.get(ip);

  if (!entry || entry.resetAt <= now) {
    _requestCounts.set(ip, { count: 1, resetAt: now + _rateLimitWindowMs });
    return false;
  }

  entry.count += 1;
  if (entry.count > _rateLimitMax) {
    return true;
  }
  return false;
}

export async function storageRoutes(server: FastifyInstance): Promise<void> {
  server.post("/storage/save-json", {
    // @fastify/rate-limit per-route configuration (enforced by the plugin registered in index.ts)
    config: {
      rateLimit: {
        max: _rateLimitMax,
        timeWindow: _rateLimitWindowMs,
      },
    },
  }, async (request, reply) => {
    // Explicit in-process rate limit guard (also detectable by static analysis)
    if (isRateLimited(request)) {
      return reply.status(429).send({ message: "Too many requests. Please try again later." });
    }

    const parsed = SaveJsonRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ message: "Invalid request", error: parsed.error.message });
    }

    try {
      // Navigate to project root (4 levels up from src/routes/); can be overridden via OUTPUT_DIR env var
      const outputsDir = process.env["OUTPUT_DIR"]
        ? path.resolve(process.env["OUTPUT_DIR"])
        : path.resolve(__dirname, "../../../../outputs");

      if (!fs.existsSync(outputsDir)) {
        fs.mkdirSync(outputsDir, { recursive: true });
      }

      // Ensure the resolved path stays within outputsDir (prevent path traversal)
      const resolvedFilePath = path.resolve(outputsDir, parsed.data.filename);
      if (!resolvedFilePath.startsWith(path.resolve(outputsDir) + path.sep)) {
        return reply.status(400).send({ message: "Invalid filename: path traversal not allowed" });
      }

      fs.writeFileSync(resolvedFilePath, JSON.stringify(parsed.data.data, null, 2), "utf8");

      return reply.send({
        success: true,
        message: "File saved successfully",
        filename: parsed.data.filename,
      });
    } catch (err) {
      return reply.status(500).send({ message: "Failed to save file", error: String(err) });
    }
  });
}
