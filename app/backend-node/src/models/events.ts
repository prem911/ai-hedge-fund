import type { ZodObject } from "zod";

// ─── Base event interface ──────────────────────────────────────────────────────
export interface BaseEvent {
  type: string;
  toSSE(): string;
}

function toSseString(event: object, type: string): string {
  return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
}

// ─── StartEvent ───────────────────────────────────────────────────────────────
export interface StartEvent extends BaseEvent {
  type: "start";
  timestamp?: string | null;
}

export function createStartEvent(timestamp?: string): StartEvent {
  const event: StartEvent = {
    type: "start",
    timestamp: timestamp ?? new Date().toISOString(),
    toSSE() {
      return toSseString({ type: this.type, timestamp: this.timestamp }, "start");
    },
  };
  return event;
}

// ─── ProgressUpdateEvent ──────────────────────────────────────────────────────
export interface ProgressUpdateEvent extends BaseEvent {
  type: "progress";
  agent: string;
  ticker?: string | null;
  status: string;
  timestamp?: string | null;
  analysis?: string | null;
}

export function createProgressUpdateEvent(
  agent: string,
  status: string,
  options?: { ticker?: string | null; timestamp?: string | null; analysis?: string | null }
): ProgressUpdateEvent {
  const event: ProgressUpdateEvent = {
    type: "progress",
    agent,
    ticker: options?.ticker ?? null,
    status,
    timestamp: options?.timestamp ?? new Date().toISOString(),
    analysis: options?.analysis ?? null,
    toSSE() {
      return toSseString(
        {
          type: this.type,
          agent: this.agent,
          ticker: this.ticker,
          status: this.status,
          timestamp: this.timestamp,
          analysis: this.analysis,
        },
        "progress"
      );
    },
  };
  return event;
}

// ─── ErrorEvent ───────────────────────────────────────────────────────────────
export interface ErrorEvent extends BaseEvent {
  type: "error";
  message: string;
  timestamp?: string | null;
}

export function createErrorEvent(message: string, timestamp?: string): ErrorEvent {
  const event: ErrorEvent = {
    type: "error",
    message,
    timestamp: timestamp ?? new Date().toISOString(),
    toSSE() {
      return toSseString({ type: this.type, message: this.message, timestamp: this.timestamp }, "error");
    },
  };
  return event;
}

// ─── CompleteEvent ────────────────────────────────────────────────────────────
export interface CompleteEvent extends BaseEvent {
  type: "complete";
  data: Record<string, unknown>;
  timestamp?: string | null;
}

export function createCompleteEvent(data: Record<string, unknown>, timestamp?: string): CompleteEvent {
  const event: CompleteEvent = {
    type: "complete",
    data,
    timestamp: timestamp ?? new Date().toISOString(),
    toSSE() {
      return toSseString({ type: this.type, data: this.data, timestamp: this.timestamp }, "complete");
    },
  };
  return event;
}
