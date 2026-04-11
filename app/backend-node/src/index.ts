import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import "dotenv/config";
import { registerRoutes } from "./routes/index.js";
import { ollamaService } from "./services/ollamaService.js";

const server = Fastify({ logger: true });

await server.register(cors, {
  origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
  credentials: true,
});

// Register rate limiting — storage route uses a per-route limit via config.rateLimit
await server.register(rateLimit, {
  global: false, // opt-in per route; routes that need it set config.rateLimit
});

await registerRoutes(server);

// Startup check for Ollama
try {
  const status = await ollamaService.checkOllamaStatus();
  if (status.installed) {
    server.log.info(
      status.running
        ? `✓ Ollama running at ${status.server_url}`
        : "ℹ Ollama installed but not running"
    );
  } else {
    server.log.info("ℹ Ollama not installed. Visit https://ollama.com");
  }
} catch {
  server.log.info("ℹ Ollama status check skipped");
}

await server.listen({ port: 8000, host: "0.0.0.0" });
