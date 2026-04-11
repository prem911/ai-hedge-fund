import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { platform } from "os";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

const OLLAMA_BASE_URL = process.env["OLLAMA_BASE_URL"] ?? `http://${process.env["OLLAMA_HOST"] ?? "localhost"}:11434`;

// ─── Types ────────────────────────────────────────────────────────────────────
export interface OllamaStatus {
  installed: boolean;
  running: boolean;
  server_running: boolean;
  available_models: string[];
  server_url: string;
  error?: string | null;
}

export interface OllamaActionResult {
  success: boolean;
  message: string;
}

export interface DownloadProgress {
  status: string;
  percentage?: number;
  message?: string;
  error?: string;
  bytes_downloaded?: number;
  total_bytes?: number;
}

// ─── OllamaService ────────────────────────────────────────────────────────────
export class OllamaService {
  private _downloadProgress: Map<string, DownloadProgress> = new Map();

  // ─── Public API ─────────────────────────────────────────────────────────────

  async checkOllamaStatus(): Promise<OllamaStatus> {
    try {
      const installed = await this._isInstalled();
      const running = await this._isRunning();
      const models = running ? await this._listModels() : [];

      return {
        installed,
        running,
        server_running: running,
        available_models: models,
        server_url: OLLAMA_BASE_URL,
        error: null,
      };
    } catch (err) {
      return {
        installed: false,
        running: false,
        server_running: false,
        available_models: [],
        server_url: OLLAMA_BASE_URL,
        error: String(err),
      };
    }
  }

  async startServer(): Promise<OllamaActionResult> {
    try {
      const os = platform();
      if (os === "win32") {
        spawn("ollama", ["serve"], { detached: true, stdio: "ignore" }).unref();
      } else {
        spawn("ollama", ["serve"], { detached: true, stdio: "ignore" }).unref();
      }
      // Give it a moment to start
      await new Promise((r) => setTimeout(r, 2000));
      const running = await this._isRunning();
      return {
        success: running,
        message: running ? "Ollama server started successfully" : "Failed to start Ollama server",
      };
    } catch (err) {
      return { success: false, message: `Error starting server: ${String(err)}` };
    }
  }

  async stopServer(): Promise<OllamaActionResult> {
    try {
      const os = platform();
      if (os === "win32") {
        await execFileAsync("taskkill", ["/F", "/IM", "ollama.exe"]);
      } else {
        await execFileAsync("pkill", ["-f", "ollama serve"]).catch(() => {/* ignore */});
      }
      return { success: true, message: "Ollama server stopped successfully" };
    } catch (err) {
      return { success: false, message: `Error stopping server: ${String(err)}` };
    }
  }

  async downloadModel(modelName: string): Promise<OllamaActionResult> {
    try {
      const running = await this._isRunning();
      if (!running) return { success: false, message: "Ollama server is not running" };

      await execFileAsync("ollama", ["pull", modelName]);
      return { success: true, message: `Model ${modelName} downloaded successfully` };
    } catch (err) {
      return { success: false, message: `Error downloading model: ${String(err)}` };
    }
  }

  async *downloadModelWithProgress(modelName: string): AsyncGenerator<string> {
    const running = await this._isRunning();
    if (!running) {
      yield `data: ${JSON.stringify({ status: "error", error: "Ollama server is not running" })}\n\n`;
      return;
    }

    yield `data: ${JSON.stringify({ status: "starting", percentage: 0, message: `Starting download of ${modelName}…` })}\n\n`;
    this._downloadProgress.set(modelName, { status: "starting", percentage: 0 });

    try {
      // Use the Ollama HTTP API to pull the model with streaming
      const response = await fetch(`${OLLAMA_BASE_URL}/api/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: modelName, stream: true }),
      });

      if (!response.ok || !response.body) {
        const msg = `Failed to start download: HTTP ${response.status}`;
        yield `data: ${JSON.stringify({ status: "error", error: msg })}\n\n`;
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        for (const line of text.split("\n").filter(Boolean)) {
          try {
            const progress = JSON.parse(line) as Record<string, unknown>;
            const status = progress["status"] as string | undefined;
            const completed = progress["completed"] as number | undefined;
            const total = progress["total"] as number | undefined;

            const progressData: DownloadProgress = { status: status ?? "downloading", message: status ?? "" };
            if (completed !== undefined && total !== undefined && total > 0) {
              progressData.percentage = (completed / total) * 100;
              progressData.bytes_downloaded = completed;
              progressData.total_bytes = total;
            }

            this._downloadProgress.set(modelName, progressData);

            if (status === "success") {
              const final = { status: "completed", percentage: 100, message: `Model ${modelName} downloaded successfully!` };
              this._downloadProgress.set(modelName, final);
              yield `data: ${JSON.stringify(final)}\n\n`;
            } else {
              yield `data: ${JSON.stringify(progressData)}\n\n`;
            }
          } catch {
            // Ignore malformed lines
          }
        }
      }
    } catch (err) {
      const errData = { status: "error", message: `Error downloading model`, error: String(err) };
      this._downloadProgress.set(modelName, errData);
      yield `data: ${JSON.stringify(errData)}\n\n`;
    } finally {
      await new Promise((r) => setTimeout(r, 1000));
      this._downloadProgress.delete(modelName);
    }
  }

  async deleteModel(modelName: string): Promise<OllamaActionResult> {
    try {
      const running = await this._isRunning();
      if (!running) return { success: false, message: "Ollama server is not running" };

      await execFileAsync("ollama", ["rm", modelName]);
      return { success: true, message: `Model ${modelName} deleted successfully` };
    } catch (err) {
      return { success: false, message: `Error deleting model: ${String(err)}` };
    }
  }

  async getRecommendedModels(): Promise<Array<{ display_name: string; model_name: string; provider: string }>> {
    const modelsPath = path.resolve(__dirname, "../../src/llm/ollama_models.json");
    try {
      if (fs.existsSync(modelsPath)) {
        const raw = fs.readFileSync(modelsPath, "utf8");
        return JSON.parse(raw) as Array<{ display_name: string; model_name: string; provider: string }>;
      }
    } catch {
      // fall through to fallback
    }
    return [
      { display_name: "Llama 3.1 (8B)", model_name: "llama3.1:latest", provider: "Ollama" },
      { display_name: "Gemma 3 (4B)", model_name: "gemma3:4b", provider: "Ollama" },
      { display_name: "Qwen 3 (4B)", model_name: "qwen3:4b", provider: "Ollama" },
    ];
  }

  async getAvailableModels(): Promise<Array<{ display_name: string; model_name: string; provider: string }>> {
    try {
      const status = await this.checkOllamaStatus();
      if (!status.server_running || !status.available_models.length) return [];

      const recommended = await this.getRecommendedModels();
      const downloadedSet = new Set(status.available_models);

      return recommended
        .filter((m) => downloadedSet.has(m.model_name))
        .map((m) => ({ ...m, provider: "Ollama" }));
    } catch {
      return [];
    }
  }

  cancelDownload(modelName: string): boolean {
    if (this._downloadProgress.has(modelName)) {
      this._downloadProgress.set(modelName, {
        status: "cancelled",
        message: `Download of ${modelName} was cancelled`,
        error: "Download cancelled by user",
      });
      return true;
    }
    return false;
  }

  getDownloadProgress(modelName: string): DownloadProgress | null {
    return this._downloadProgress.get(modelName) ?? null;
  }

  getAllDownloadProgress(): Record<string, DownloadProgress> {
    return Object.fromEntries(this._downloadProgress);
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private async _isInstalled(): Promise<boolean> {
    try {
      const cmd = platform() === "win32" ? "where" : "which";
      await execFileAsync(cmd, ["ollama"]);
      return true;
    } catch {
      return false;
    }
  }

  private async _isRunning(): Promise<boolean> {
    try {
      const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async _listModels(): Promise<string[]> {
    try {
      const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return [];
      const data = (await response.json()) as { models?: Array<{ name: string }> };
      return (data.models ?? []).map((m) => m.name);
    } catch {
      return [];
    }
  }
}

export const ollamaService = new OllamaService();
