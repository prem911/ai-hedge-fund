import type { FastifyInstance } from "fastify";
import {
  FlowRunCreateRequestSchema,
  FlowRunUpdateRequestSchema,
} from "../models/schemas.js";
import * as flowRunRepo from "../repositories/flowRunRepository.js";

export async function flowRunRoutes(server: FastifyInstance): Promise<void> {
  // POST /flows/:flowId/runs
  server.post<{ Params: { flowId: string } }>("/flows/:flowId/runs", async (request, reply) => {
    const flowId = parseInt(request.params.flowId, 10);
    if (isNaN(flowId)) return reply.status(400).send({ message: "Invalid flow ID" });
    const parsed = FlowRunCreateRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ message: "Invalid request", error: parsed.error.message });
    const run = await flowRunRepo.createFlowRun(flowId, parsed.data.request_data ?? null);
    return reply.status(201).send(run);
  });

  // GET /flows/:flowId/runs
  server.get<{ Params: { flowId: string } }>("/flows/:flowId/runs", async (request, reply) => {
    const flowId = parseInt(request.params.flowId, 10);
    if (isNaN(flowId)) return reply.status(400).send({ message: "Invalid flow ID" });
    const runs = await flowRunRepo.getFlowRunsByFlowId(flowId);
    return reply.send(runs);
  });

  // GET /flows/:flowId/runs/count
  server.get<{ Params: { flowId: string } }>("/flows/:flowId/runs/count", async (request, reply) => {
    const flowId = parseInt(request.params.flowId, 10);
    if (isNaN(flowId)) return reply.status(400).send({ message: "Invalid flow ID" });
    const count = await flowRunRepo.getFlowRunCount(flowId);
    return reply.send({ count });
  });

  // GET /flows/:flowId/runs/active
  server.get<{ Params: { flowId: string } }>("/flows/:flowId/runs/active", async (request, reply) => {
    const flowId = parseInt(request.params.flowId, 10);
    if (isNaN(flowId)) return reply.status(400).send({ message: "Invalid flow ID" });
    const run = await flowRunRepo.getActiveFlowRun(flowId);
    if (!run) return reply.status(404).send({ message: "No active run found" });
    return reply.send(run);
  });

  // GET /flows/:flowId/runs/latest
  server.get<{ Params: { flowId: string } }>("/flows/:flowId/runs/latest", async (request, reply) => {
    const flowId = parseInt(request.params.flowId, 10);
    if (isNaN(flowId)) return reply.status(400).send({ message: "Invalid flow ID" });
    const run = await flowRunRepo.getLatestFlowRun(flowId);
    if (!run) return reply.status(404).send({ message: "No runs found" });
    return reply.send(run);
  });

  // GET /flows/:flowId/runs/:runId
  server.get<{ Params: { flowId: string; runId: string } }>("/flows/:flowId/runs/:runId", async (request, reply) => {
    const runId = parseInt(request.params.runId, 10);
    if (isNaN(runId)) return reply.status(400).send({ message: "Invalid run ID" });
    const run = await flowRunRepo.getFlowRunById(runId);
    if (!run) return reply.status(404).send({ message: "Flow run not found" });
    return reply.send(run);
  });

  // PUT /flows/:flowId/runs/:runId
  server.put<{ Params: { flowId: string; runId: string } }>("/flows/:flowId/runs/:runId", async (request, reply) => {
    const runId = parseInt(request.params.runId, 10);
    if (isNaN(runId)) return reply.status(400).send({ message: "Invalid run ID" });
    const parsed = FlowRunUpdateRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ message: "Invalid request", error: parsed.error.message });
    const updated = await flowRunRepo.updateFlowRun(runId, {
      status: parsed.data.status,
      results: parsed.data.results ?? null,
      error_message: parsed.data.error_message ?? null,
    });
    if (!updated) return reply.status(404).send({ message: "Flow run not found" });
    return reply.send(updated);
  });

  // DELETE /flows/:flowId/runs/:runId
  server.delete<{ Params: { flowId: string; runId: string } }>("/flows/:flowId/runs/:runId", async (request, reply) => {
    const runId = parseInt(request.params.runId, 10);
    if (isNaN(runId)) return reply.status(400).send({ message: "Invalid run ID" });
    const deleted = await flowRunRepo.deleteFlowRun(runId);
    if (!deleted) return reply.status(404).send({ message: "Flow run not found" });
    return reply.status(204).send();
  });

  // DELETE /flows/:flowId/runs
  server.delete<{ Params: { flowId: string } }>("/flows/:flowId/runs", async (request, reply) => {
    const flowId = parseInt(request.params.flowId, 10);
    if (isNaN(flowId)) return reply.status(400).send({ message: "Invalid flow ID" });
    const count = await flowRunRepo.deleteFlowRunsByFlowId(flowId);
    return reply.send({ deleted: count });
  });
}
