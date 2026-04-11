import type { FastifyInstance } from "fastify";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SaveJsonRequestSchema = z.object({
  filename: z.string().min(1).max(255).regex(/^[\w\-.]+\.json$/, "Filename must be a safe .json filename"),
  data: z.record(z.unknown()),
});

export async function storageRoutes(server: FastifyInstance): Promise<void> {
  server.post("/storage/save-json", {
    config: {
      rateLimit: {
        max: 30,
        timeWindow: "1 minute",
      },
    },
  }, async (request, reply) => {
    const parsed = SaveJsonRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ message: "Invalid request", error: parsed.error.message });
    }

    try {
      // Navigate to project root (4 levels up from src/routes/)
      const projectRoot = path.resolve(__dirname, "../../../../");
      const outputsDir = path.join(projectRoot, "outputs");

      if (!fs.existsSync(outputsDir)) {
        fs.mkdirSync(outputsDir, { recursive: true });
      }

      // Ensure the resolved path stays within outputsDir (prevent path traversal)
      const filePath = path.join(outputsDir, parsed.data.filename);
      const resolvedFilePath = path.resolve(filePath);
      if (!resolvedFilePath.startsWith(path.resolve(outputsDir) + path.sep)) {
        return reply.status(400).send({ message: "Invalid filename: path traversal not allowed" });
      }

      fs.writeFileSync(resolvedFilePath, JSON.stringify(parsed.data.data, null, 2), "utf8");

      return reply.send({
        success: true,
        message: `File saved successfully`,
        filename: parsed.data.filename,
      });
    } catch (err) {
      return reply.status(500).send({ message: "Failed to save file", error: String(err) });
    }
  });
}
