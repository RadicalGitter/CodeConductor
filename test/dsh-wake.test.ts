import { expect, test } from "bun:test";

import { wakeDshSession } from "../src/dsh-wake.js";

test("posts a queued follow-up to the exact local DSH session", async () => {
  let observedUrl: string | undefined;
  let observedInit: RequestInit | undefined;
  const fakeFetch: typeof fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      observedUrl = String(input);
      observedInit = init;
      const request = JSON.parse(String(init?.body)) as {
        rpcId: string;
        method: string;
        payload: { sessionId: string; mode: string; content: unknown[] };
      };
      return Response.json({
        type: "server-response",
        rpcId: request.rpcId,
        result: { ok: true, value: { accepted: true } },
      });
    },
    { preconnect: fetch.preconnect },
  );

  await wakeDshSession(
    {
      webUrl: "http://127.0.0.1:3080",
      sessionId: "session-fixture",
      text: "Conductor finished.",
    },
    fakeFetch,
  );

  expect(observedUrl).toBe("http://127.0.0.1:3080/api/session.prompt");
  expect(observedInit?.method).toBe("POST");
  const body = JSON.parse(String(observedInit?.body)) as {
    method: string;
    payload: { sessionId: string; mode: string; content: unknown[] };
  };
  expect(body.method).toBe("session.prompt");
  expect(body.payload).toEqual({
    sessionId: "session-fixture",
    mode: "queue",
    content: [{ type: "text", text: "Conductor finished." }],
  });
});

test("refuses to send session prompts to non-loopback hosts", async () => {
  expect(
    wakeDshSession({
      webUrl: "https://example.com",
      sessionId: "session-fixture",
      text: "No.",
    }),
  ).rejects.toThrow("non-loopback");
});
