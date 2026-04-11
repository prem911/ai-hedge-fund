import type { FastifyInstance } from "fastify";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SaveJsonRequestSchema = z.object({
  filename: z.string().min(1),
  data: z.record(z.any()),
});

export async function storageRoutes(server: FastifyInstance): Promise<void> {
  server.post("/storage/save-json", async (request, reply) => {
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

      const filePath = path.join(outputsDir, parsed.data.filename);
      fs.writeFileSync(filePath, JSON.stringify(parsed.data.data, null, 2), "utf8");

      return reply.send({
        success: true,
        message: `File saved successfully to ${filePath}`,
        filename: parsed.data.filename,
      });
    } catch (err) {
      return reply.status(500).send({ message: "Failed to save file", error: String(err) });
    }
  });
}
