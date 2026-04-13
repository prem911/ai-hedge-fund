import type { FastifyInstance } from "fastify";
import {
  FlowCreateRequestSchema,
  FlowUpdateRequestSchema,
} from "../models/schemas.js";
import * as flowRepo from "../repositories/flowRepository.js";

export async function flowRoutes(server: FastifyInstance): Promise<void> {
  // POST /flows/
  server.post("/flows/", async (request, reply) => {
    const parsed = FlowCreateRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ message: "Invalid request", error: parsed.error.message });
    const d = parsed.data;
    const flow = await flowRepo.createFlow({
      name: d.name,
      description: d.description,
      nodes: d.nodes,
      edges: d.edges,
      viewport: d.viewport,
      data: d.data,
      is_template: d.is_template,
      tags: d.tags,
    });
    return reply.status(201).send(flow);
  });

  // GET /flows/
  server.get("/flows/", async (_request, reply) => {
    const flows = await flowRepo.getAllFlows();
    return reply.send(flows);
  });

  // GET /flows/search/:name
  server.get<{ Params: { name: string } }>("/flows/search/:name", async (request, reply) => {
    const flows = await flowRepo.getFlowsByName(request.params.name);
    return reply.send(flows);
  });

  // GET /flows/:flowId
  server.get<{ Params: { flowId: string } }>("/flows/:flowId", async (request, reply) => {
    const id = parseInt(request.params.flowId, 10);
    if (isNaN(id)) return reply.status(400).send({ message: "Invalid flow ID" });
    const flow = await flowRepo.getFlowById(id);
    if (!flow) return reply.status(404).send({ message: "Flow not found" });
    return reply.send(flow);
  });

  // PUT /flows/:flowId
  server.put<{ Params: { flowId: string } }>("/flows/:flowId", async (request, reply) => {
    const id = parseInt(request.params.flowId, 10);
    if (isNaN(id)) return reply.status(400).send({ message: "Invalid flow ID" });
    const parsed = FlowUpdateRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ message: "Invalid request", error: parsed.error.message });
    const d = parsed.data;
    const updated = await flowRepo.updateFlow(id, {
      name: d.name,
      description: d.description,
      nodes: d.nodes,
      edges: d.edges,
      viewport: d.viewport,
      data: d.data,
      is_template: d.is_template,
      tags: d.tags,
    });
    if (!updated) return reply.status(404).send({ message: "Flow not found" });
    return reply.send(updated);
  });

  // DELETE /flows/:flowId
  server.delete<{ Params: { flowId: string } }>("/flows/:flowId", async (request, reply) => {
    const id = parseInt(request.params.flowId, 10);
    if (isNaN(id)) return reply.status(400).send({ message: "Invalid flow ID" });
    const deleted = await flowRepo.deleteFlow(id);
    if (!deleted) return reply.status(404).send({ message: "Flow not found" });
    return reply.status(204).send();
  });

  // POST /flows/:flowId/duplicate
  server.post<{ Params: { flowId: string } }>("/flows/:flowId/duplicate", async (request, reply) => {
    const id = parseInt(request.params.flowId, 10);
    if (isNaN(id)) return reply.status(400).send({ message: "Invalid flow ID" });
    const body = (request.body ?? {}) as { name?: string };
    const duplicated = await flowRepo.duplicateFlow(id, body.name);
    if (!duplicated) return reply.status(404).send({ message: "Flow not found" });
    return reply.status(201).send(duplicated);
  });
}
