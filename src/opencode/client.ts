import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import type { SessionPermissionRule } from "./permissions.ts";

export interface ModelSpec {
  readonly providerID: string;
  readonly id: string;
}

export function parseModelSpec(
  explicitSpec?: string,
  env: Record<string, string | undefined> = process.env,
): ModelSpec {
  const raw = (explicitSpec ?? env.PEER_MODEL ?? env.MODEL ?? "hy4-flash-free").trim();
  const slashIdx = raw.indexOf("/");
  if (slashIdx > 0 && slashIdx < raw.length - 1) {
    return {
      providerID: raw.slice(0, slashIdx),
      id: raw.slice(slashIdx + 1),
    };
  }
  return {
    providerID: "opencode",
    id: raw.length > 0 ? raw : "hy4-flash-free",
  };
}

export interface OpenCodeAssistantMessagePart {
  readonly type: string;
  readonly text?: string;
}

export interface OpenCodeMessageError {
  readonly type?: string;
  readonly message?: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
}

export interface OpenCodeSessionMessage {
  readonly type: string;
  readonly finish?: string;
  readonly outcome?: string;
  readonly error?: OpenCodeMessageError;
  readonly content?: readonly OpenCodeAssistantMessagePart[];
}

export class OpenCodeProviderQuotaError extends Error {
  public readonly status: number | undefined;
  public readonly retryAfterMs: number | undefined;
  public readonly errorType: string;

  constructor(options: {
    errorType: string;
    message: string;
    status?: number;
    retryAfterMs?: number;
  }) {
    const retryHint =
      typeof options.retryAfterMs === "number" && options.retryAfterMs > 0
        ? ` (retry after ~${Math.ceil(options.retryAfterMs / 60_000)}m)`
        : "";
    super(
      `OpenCode provider error [${options.errorType}${options.status ? ` HTTP ${options.status}` : ""}]: ${options.message}${retryHint}`,
    );
    this.name = "OpenCodeProviderQuotaError";
    this.errorType = options.errorType;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export interface OpenCodeClientLike {
  readonly session: {
    create(input: {
      location?: { directory: string };
      model?: { providerID: string; id: string };
      title?: string;
      permissions?: readonly SessionPermissionRule[];
    }): Promise<{ id: string }>;
    prompt(input: { sessionID: string; text: string }): Promise<unknown>;
    remove(input: { sessionID: string }): Promise<unknown>;
  };
  readonly experimental: {
    readonly session: {
      wait(input: { sessionID: string }): Promise<unknown>;
    };
  };
  readonly message: {
    list(input: {
      sessionID: string;
      type?: "assistant";
    }): Promise<{ data: readonly OpenCodeSessionMessage[] }>;
  };
}

export async function createDefaultOpenCodeClient(): Promise<OpenCodeClientLike> {
  const endpoint = await Service.ensure();
  const noIdleTimeoutFetch = ((input: string | URL | Request, init?: RequestInit) =>
    globalThis.fetch(input, {
      ...init,
      // Disable Bun's 300s default socket idle timeout on long-polling session.wait requests
      timeout: false,
    } as RequestInit)) as typeof globalThis.fetch;

  return OpenCode.make({
    baseUrl: endpoint.url,
    headers: Service.headers(endpoint),
    fetch: noIdleTimeoutFetch,
  }) as unknown as OpenCodeClientLike;
}
