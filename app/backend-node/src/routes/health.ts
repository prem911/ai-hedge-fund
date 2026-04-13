import type { FastifyInstance } from "fastify";

export async function healthRoutes(server: FastifyInstance): Promise<void> {
  server.get("/health", async (_request, reply) => {
    return reply.send({ status: "ok" });
  });

  server.get("/", async (_request, reply) => {
    return reply.send({ message: "Welcome to AI Hedge Fund API (Node.js)" });
  });

  server.get("/ping", async (_request, reply) => {
    return reply.send({ pong: true, timestamp: new Date().toISOString() });
  });
}
