import type { FastifyReply } from "fastify";
import type { TurnEvent } from "../core/types.js";

export type ErrorDialect = "openai" | "anthropic";

export class ProtocolError extends Error {
  constructor(
    readonly status: number,
    readonly dialect: ErrorDialect,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

export type RouteErrorCode =
  | "model_not_found"
  | "queue_timeout"
  | "upstream_auth"
  | "upstream_timeout"
  | "upstream_browser"
  | "rate_limited"
  | "client_aborted"
  | "unknown";

export class RouteError extends Error {
  constructor(
    readonly code: RouteErrorCode,
    message?: string,
    readonly retryAfterSec?: number,
  ) {
    super(message ?? code);
    this.name = "RouteError";
  }
}

export interface MappedError {
  status: number;
  body: Record<string, unknown>;
  retryAfterSec?: number;
}

function body(dialect: ErrorDialect, message: string, openAiType: string, anthropicType: string, code?: string) {
  if (dialect === "openai") {
    return { error: { message, type: openAiType, ...(code ? { code } : {}) } };
  }
  return { type: "error", error: { type: anthropicType, message } };
}

export function mapProtocolError(err: ProtocolError): MappedError {
  return {
    status: err.status,
    body: body(err.dialect, err.message, "invalid_request_error", "invalid_request_error", err.code || undefined),
  };
}

export function mapRouteError(err: RouteError, dialect: ErrorDialect): MappedError {
  switch (err.code) {
    case "model_not_found":
      return { status: 404, body: body(dialect, err.message, "invalid_request_error", "not_found_error", "model_not_found") };
    case "rate_limited":
      return { status: 429, retryAfterSec: err.retryAfterSec, body: body(dialect, err.message, "rate_limit_error", "rate_limit_error") };
    case "queue_timeout":
      return { status: 503, retryAfterSec: err.retryAfterSec ?? 5, body: body(dialect, err.message, "server_error", "overloaded_error", "queue_timeout") };
    case "upstream_auth":
      return { status: 502, body: body(dialect, err.message, "server_error", "api_error", "upstream_auth") };
    case "upstream_timeout":
      return { status: 504, body: body(dialect, err.message, "server_error", "api_error", "upstream_timeout") };
    case "client_aborted":
      return { status: 499, body: body(dialect, err.message, "server_error", "api_error", "client_aborted") };
    case "upstream_browser":
    case "unknown":
    default:
      return { status: 502, body: body(dialect, err.message, "server_error", "api_error", err.code) };
  }
}

export function mapTurnError(event: Extract<TurnEvent, { type: "error" }>, dialect: ErrorDialect): MappedError {
  switch (event.kind) {
    case "rate_limit":
      return mapRouteError(new RouteError("rate_limited", event.message, event.retryAfterSec), dialect);
    case "auth":
      return mapRouteError(new RouteError("upstream_auth", event.message), dialect);
    case "timeout":
      return mapRouteError(new RouteError("upstream_timeout", event.message), dialect);
    case "browser":
      return mapRouteError(new RouteError("upstream_browser", event.message), dialect);
    default:
      return mapRouteError(new RouteError("unknown", event.message), dialect);
  }
}

export function sendMappedError(reply: FastifyReply, mapped: MappedError): void {
  if (mapped.retryAfterSec !== undefined) {
    reply.header("Retry-After", String(mapped.retryAfterSec));
  }
  reply.code(mapped.status).send(mapped.body);
}

export function isMappedError(err: unknown): err is MappedError {
  return typeof err === "object" && err !== null && "status" in err && "body" in err;
}
