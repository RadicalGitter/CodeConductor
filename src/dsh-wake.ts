import { randomUUID } from "node:crypto";

export interface DshWakeRequest {
  webUrl: string;
  sessionId: string;
  text: string;
}

export async function wakeDshSession(
  input: DshWakeRequest,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const base = new URL(input.webUrl);
  if (!isLoopback(base.hostname)) {
    throw new Error(
      `Refusing to wake a non-loopback DSH host: ${base.hostname}`,
    );
  }
  const rpcId = `conductor-wake-${randomUUID()}`;
  const response = await fetchFn(new URL("/api/session.prompt", base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "client-request",
      rpcId,
      method: "session.prompt",
      payload: {
        sessionId: input.sessionId,
        mode: "queue",
        content: [{ type: "text", text: input.text }],
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`DSH wake request failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    rpcId?: unknown;
    result?: { ok?: unknown; error?: { code?: unknown; message?: unknown } };
  };
  if (body.rpcId !== rpcId) throw new Error("DSH wake response rpcId mismatch");
  if (body.result?.ok !== true) {
    const code = body.result?.error?.code ?? "unknown";
    const message = body.result?.error?.message ?? "unknown error";
    throw new Error(`DSH rejected wake request: ${code}: ${message}`);
  }
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]"
  );
}
