import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { isIP, type AddressInfo } from "node:net";

import { validateConsoleSettings } from "../model-service/settings-contract.js";
import {
  SettingsRevisionConflictError,
  type ConsoleSettingsStore,
} from "../model-service/settings-store.js";
import type { ModelServiceManager } from "../model-service/manager.js";
import type { DurableDispatcher } from "../queue/dispatcher.js";
import { buildSnapshot, type SnapshotSources } from "./snapshot.js";
import {
  CONTROL_CONSOLE_CSS,
  CONTROL_CONSOLE_JS,
  queuePage,
  settingsPage,
} from "./ui.js";

export interface ControlConsoleDependencies {
  dispatcher: DurableDispatcher;
  modelService?: ModelServiceManager;
  settingsStore: ConsoleSettingsStore;
  snapshotSources: SnapshotSources;
  queueControlAuthority?: boolean;
}

export interface ControlConsoleOptions {
  host: string;
  port: number;
  csrfTtlMs?: number;
  eventIntervalMs?: number;
}

export interface ControlConsole {
  host: string;
  port: number;
  url: string;
  queueUrl: string;
  settingsUrl: string;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 1_000_000;
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1_000;

export async function startControlConsole(
  dependencies: ControlConsoleDependencies,
  options: ControlConsoleOptions,
): Promise<ControlConsole> {
  await verifyLoopbackResolution(options.host);
  await dependencies.modelService?.observe();
  const csrfTokens = new Map<string, number>();
  const idempotency = new Map<
    string,
    { expiresAt: number; fingerprint: string; status: number; body: object }
  >();
  const csrfTtlMs = options.csrfTtlMs ?? 15 * 60 * 1_000;
  const eventIntervalMs = options.eventIntervalMs ?? 2_000;
  const eventStreams = new Set<{
    response: ServerResponse;
    previousRevision: string;
  }>();
  let broadcastRunning = false;
  const broadcastSnapshots = async (): Promise<void> => {
    if (broadcastRunning || eventStreams.size === 0) return;
    broadcastRunning = true;
    try {
      const snapshot = await buildSnapshot(dependencies.snapshotSources);
      const data = JSON.stringify(snapshot);
      for (const stream of eventStreams) {
        try {
          if (stream.previousRevision !== snapshot.revision) {
            stream.previousRevision = snapshot.revision;
            stream.response.write(
              `id: ${snapshot.revision}\nevent: snapshot\ndata: ${data}\n\n`,
            );
          } else {
            stream.response.write(": keepalive\n\n");
          }
        } catch {
          eventStreams.delete(stream);
          stream.response.end();
        }
      }
    } finally {
      broadcastRunning = false;
    }
  };
  const broadcastTimer = setInterval(
    () => void broadcastSnapshots().catch(() => undefined),
    eventIntervalMs,
  );
  let origin = "";

  const server = createServer((request, response) => {
    void route(request, response).catch((error: unknown) => {
      const status =
        error instanceof HttpError
          ? error.status
          : error instanceof SettingsRevisionConflictError
            ? 409
            : 500;
      sendJson(response, status, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.host, () => resolve());
    });
  } catch (error) {
    clearInterval(broadcastTimer);
    throw error;
  }
  const address = server.address() as AddressInfo;
  origin = `http://${urlHost(options.host)}:${address.port}`;

  async function route(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", origin);
    if (request.method === "GET") {
      if (url.pathname === "/health") {
        return sendJson(response, 200, {
          schema: "conductor.control-console-health/v1",
          ready: true,
        });
      }
      if (["/", "/queue"].includes(url.pathname)) {
        return sendHtml(response, queuePage());
      }
      if (url.pathname === "/settings") {
        return sendHtml(response, settingsPage());
      }
      if (url.pathname === "/assets/console.css") {
        return sendAsset(
          response,
          "text/css; charset=utf-8",
          CONTROL_CONSOLE_CSS,
        );
      }
      if (url.pathname === "/assets/console.js") {
        return sendAsset(
          response,
          "text/javascript; charset=utf-8",
          CONTROL_CONSOLE_JS,
        );
      }
      if (url.pathname === "/api/v1/session") {
        prune(csrfTokens);
        const csrfToken = randomUUID();
        csrfTokens.set(csrfToken, Date.now() + csrfTtlMs);
        return sendJson(response, 200, {
          schema: "conductor.control-console-session/v1",
          csrfToken,
          expiresAt: new Date(Date.now() + csrfTtlMs).toISOString(),
        });
      }
      if (url.pathname === "/api/v1/snapshot") {
        return sendJson(
          response,
          200,
          await buildSnapshot(dependencies.snapshotSources),
        );
      }
      if (url.pathname === "/api/v1/events") {
        return streamSnapshots(request, response);
      }
      throw new HttpError(404, "Not found");
    }
    if (request.method !== "POST") {
      throw new HttpError(405, "Method not allowed");
    }
    const body = await authorizeMutation(request);
    const idempotencyKey = requiredString(
      body.idempotencyKey,
      "idempotencyKey",
    );
    const operationFingerprint = mutationFingerprint(url.pathname, body);
    pruneIdempotency(idempotency);
    const replay = idempotency.get(idempotencyKey);
    if (replay) {
      if (replay.fingerprint !== operationFingerprint) {
        throw new HttpError(
          409,
          "Idempotency key was already bound to a different mutation",
        );
      }
      return sendJson(response, replay.status, replay.body);
    }

    let result: object;
    if (url.pathname === "/api/v1/queue/cancel") {
      requireQueueControlAuthority();
      const item = await expectedQueueItem(body);
      result = { item: await dependencies.dispatcher.cancel(item.jobId) };
    } else if (url.pathname === "/api/v1/queue/retry") {
      requireQueueControlAuthority();
      const item = await expectedQueueItem(body);
      result = { item: await dependencies.dispatcher.retry(item.jobId) };
    } else if (url.pathname === "/api/v1/settings") {
      const expectedRevision = requiredInteger(
        body.expectedRevision,
        "expectedRevision",
      );
      const settings = validateConsoleSettings(body.settings);
      result = {
        document: await dependencies.settingsStore.update(
          settings,
          expectedRevision,
        ),
        appliesTo: "future-transitions; bind changes require console restart",
      };
    } else if (url.pathname === "/api/v1/model/load") {
      const manager = requireModelManager();
      assertModelRevision(manager, body);
      const record = await manager.ensureReady();
      if (record.state !== "ready") throw modelTransitionError(record);
      result = { model: publicModel(record, manager.canUnload()) };
    } else if (url.pathname === "/api/v1/model/unload") {
      const manager = requireModelManager();
      assertModelRevision(manager, body);
      const record = await manager.stop();
      if (
        record.state !== "offline" ||
        record.operation?.kind !== "stop" ||
        record.operation.status !== "completed"
      ) {
        throw modelTransitionError(record);
      }
      result = { model: publicModel(record, false) };
    } else {
      throw new HttpError(404, "Not found");
    }
    idempotency.set(idempotencyKey, {
      expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
      fingerprint: operationFingerprint,
      status: 200,
      body: result,
    });
    sendJson(response, 200, result);
  }

  async function expectedQueueItem(body: Record<string, unknown>) {
    const jobId = requiredString(body.jobId, "jobId");
    const expectedRevision = requiredInteger(
      body.expectedRevision,
      "expectedRevision",
    );
    const item = await dependencies.dispatcher.get(jobId);
    if (item.revision !== expectedRevision) {
      throw new HttpError(
        409,
        `Queue item ${jobId} changed from revision ${expectedRevision} to ${item.revision}`,
      );
    }
    return item;
  }

  function requireQueueControlAuthority(): void {
    if (!dependencies.queueControlAuthority) {
      throw new HttpError(
        409,
        "Queue control is owned by another Conductor dispatcher process",
      );
    }
  }

  function requireModelManager(): ModelServiceManager {
    if (!dependencies.modelService) {
      throw new HttpError(409, "Model service is not configured");
    }
    return dependencies.modelService;
  }

  function assertModelRevision(
    manager: ModelServiceManager,
    body: Record<string, unknown>,
  ): void {
    const expected = requiredInteger(body.expectedRevision, "expectedRevision");
    const actual = manager.state()?.revision ?? 0;
    if (expected !== actual) {
      throw new HttpError(
        409,
        `Model state changed from revision ${expected} to ${actual}`,
      );
    }
  }

  async function authorizeMutation(
    request: IncomingMessage,
  ): Promise<Record<string, unknown>> {
    const requestOrigin = request.headers.origin;
    if (requestOrigin !== undefined && requestOrigin !== origin) {
      throw new HttpError(403, "Foreign Origin is not permitted");
    }
    const mediaType = request.headers["content-type"]?.split(";", 1)[0];
    if (mediaType !== "application/json") {
      throw new HttpError(415, "Mutations require application/json");
    }
    const body = await readJsonBody(request);
    prune(csrfTokens);
    const token = requiredString(body.csrfToken, "csrfToken");
    if ((csrfTokens.get(token) ?? 0) <= Date.now()) {
      throw new HttpError(403, "CSRF token is missing or expired");
    }
    return body;
  }

  async function streamSnapshots(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    response.writeHead(
      200,
      securityHeaders({
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      }),
    );
    const stream = { response, previousRevision: "" };
    eventStreams.add(stream);
    await broadcastSnapshots();
    request.once("close", () => {
      eventStreams.delete(stream);
    });
  }

  return {
    host: options.host,
    port: address.port,
    url: origin,
    queueUrl: `${origin}/queue`,
    settingsUrl: `${origin}/settings`,
    close: () => {
      clearInterval(broadcastTimer);
      for (const stream of eventStreams) stream.response.end();
      eventStreams.clear();
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

async function verifyLoopbackResolution(host: string): Promise<void> {
  if (isIP(host)) {
    if (!isLoopbackAddress(host))
      throw new Error("Console host is not loopback");
    return;
  }
  const addresses = await lookup(host, { all: true, verbatim: true });
  if (
    addresses.length === 0 ||
    addresses.some((entry) => !isLoopbackAddress(entry.address))
  ) {
    throw new Error(
      `Console host ${host} does not resolve exclusively to loopback`,
    );
  }
}

function isLoopbackAddress(address: string): boolean {
  return address === "127.0.0.1" || address === "::1";
}

async function readJsonBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES)
      throw new HttpError(413, "Request body is too large");
    chunks.push(buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Malformed JSON body");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "JSON body must be an object");
  }
  return parsed as Record<string, unknown>;
}

function modelTransitionError(
  record: NonNullable<ReturnType<ModelServiceManager["state"]>>,
): HttpError {
  const conflictKinds = new Set([
    "wrong-model",
    "context-unverified",
    "stop-refused",
  ]);
  return new HttpError(
    record.failure && conflictKinds.has(record.failure.kind) ? 409 : 503,
    record.failure?.message ?? `Model transition ended in ${record.state}`,
  );
}

function publicModel(
  record: ReturnType<ModelServiceManager["state"]>,
  canUnload = false,
) {
  return record
    ? {
        profileId: record.profileId,
        state: record.state,
        expected: record.expected ?? null,
        observed: record.observed ?? null,
        managerOwned: record.ownership !== undefined,
        canUnload,
        revision: record.revision,
        updatedAt: record.updatedAt,
        failure: record.failure ?? null,
        operation: record.operation ?? null,
      }
    : null;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(400, `${name} must be a non-empty string`);
  }
  return value;
}

function requiredInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new HttpError(400, `${name} must be an integer`);
  }
  return value as number;
}

function prune(tokens: Map<string, number>): void {
  const now = Date.now();
  for (const [token, expiresAt] of tokens) {
    if (expiresAt <= now) tokens.delete(token);
  }
}

function mutationFingerprint(
  route: string,
  body: Record<string, unknown>,
): string {
  const operation = Object.fromEntries(
    Object.entries(body).filter(
      ([key]) => !["csrfToken", "idempotencyKey"].includes(key),
    ),
  );
  return JSON.stringify({ route, operation });
}

function pruneIdempotency(
  entries: Map<
    string,
    { expiresAt: number; fingerprint: string; status: number; body: object }
  >,
): void {
  const now = Date.now();
  for (const [key, entry] of entries) {
    if (entry.expiresAt <= now) entries.delete(key);
  }
}

function sendHtml(response: ServerResponse, html: string): void {
  sendAsset(response, "text/html; charset=utf-8", html);
}

function sendAsset(
  response: ServerResponse,
  contentType: string,
  content: string,
): void {
  response.writeHead(
    200,
    securityHeaders({
      "content-type": contentType,
      "content-length": Buffer.byteLength(content),
      "cache-control": "no-store",
    }),
  );
  response.end(content);
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: object,
): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  const payload = JSON.stringify(body);
  response.writeHead(
    status,
    securityHeaders({
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
      "cache-control": "no-store",
    }),
  );
  response.end(payload);
}

function securityHeaders(
  headers: Record<string, string | number>,
): Record<string, string | number> {
  return {
    ...headers,
    "content-security-policy":
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cross-origin-resource-policy": "same-origin",
  };
}

function urlHost(host: string): string {
  return host === "::1" ? "[::1]" : host;
}
