import { EventEmitter } from "events";

type ProgressHandler = (agentName: string, ticker: string | null, status: string, analysis: string | null, timestamp: string) => void;

class ProgressTracker extends EventEmitter {
  private handlers: ProgressHandler[] = [];

  updateStatus(agentName: string, ticker: string | null, status: string, analysis?: string | null): void {
    const timestamp = new Date().toISOString();
    for (const handler of this.handlers) {
      handler(agentName, ticker ?? null, status, analysis ?? null, timestamp);
    }
  }

  registerHandler(fn: ProgressHandler): void {
    this.handlers.push(fn);
  }

  unregisterHandler(fn: ProgressHandler): void {
    this.handlers = this.handlers.filter((h) => h !== fn);
  }
}

export const progress = new ProgressTracker();
