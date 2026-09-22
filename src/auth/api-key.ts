import { timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { customAlphabet } from "nanoid";
import type { FastifyReply, FastifyRequest } from "fastify";

const generateSuffix = customAlphabet("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 40);

export function apiKeyFilePath(dataDir: string): string {
  return resolve(dataDir, "api-key.txt");
}

/**
 * Returns the client API key: the configured one, else the key persisted in the data
 * directory, else a freshly generated key written there with owner-only permissions.
 */
export function resolveApiKey(dataDir: string, configured?: string): { key: string; source: "env" | "file" | "generated" } {
  if (configured) return { key: configured, source: "env" };
  const path = apiKeyFilePath(dataDir);
  if (existsSync(path)) {
    const stored = readFileSync(path, "utf8").trim();
    if (stored.length > 0) return { key: stored, source: "file" };
  }
  const key = `sk-mta-${generateSuffix()}`;
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path, `${key}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort on Windows */
  }
  return { key, source: "generated" };
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function extractApiKey(request: FastifyRequest): string | undefined {
  const auth = request.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length).trim();
  const header = request.headers["x-api-key"];
  if (typeof header === "string" && header.length > 0) return header;
  return undefined;
}

export function apiKeyPreHandler(expected: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const presented = extractApiKey(request);
    if (!presented) {
      await reply.code(401).send({ error: { message: "Missing API key", type: "authentication_error" } });
      return;
    }
    if (!constantTimeEqual(presented, expected)) {
      await reply.code(401).send({ error: { message: "Invalid API key", type: "authentication_error" } });
    }
  };
}
