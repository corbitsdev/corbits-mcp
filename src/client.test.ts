import { describe, expect, test, afterEach } from "bun:test";
import { type } from "arktype";

import { mcpCallTool, mcpInitialize, mcpListTools } from "./client.js";
import { startTestMcpServer, type TestServerHandle } from "./test-server.js";

const RequestIdOnly = type({ id: "number" });

let handle: TestServerHandle | undefined;
afterEach(() => {
  handle?.stop();
  handle = undefined;
});

describe("mcpInitialize / mcpListTools / mcpCallTool over JSON", () => {
  test("lists tools and calls one", async () => {
    handle = startTestMcpServer();
    await mcpInitialize(handle.url);
    const tools = await mcpListTools(handle.url);
    expect(tools.map((t) => t.name)).toEqual(["echo", "delete_thing"]);
    expect(tools[1]?.annotations?.destructiveHint).toBe(true);

    const result = await mcpCallTool(handle.url, "echo", { text: "hi" });
    expect(result.content).toBe("hi");
  });

  test("surfaces a JSON-RPC error as McpError", async () => {
    handle = startTestMcpServer({ requireAuth: "Bearer secret" });
    await expect(mcpInitialize(handle.url)).rejects.toThrow();
  });

  test("sends the credential's fetch through unauthenticated by default", async () => {
    handle = startTestMcpServer({ requireAuth: "Bearer secret" });
    await mcpInitialize(handle.url, {
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          headers: { ...init?.headers, authorization: "Bearer secret" },
        }),
    });
    expect(handle.requestsSeen[0]?.headers.get("authorization")).toBe(
      "Bearer secret",
    );
  });
});

describe("SSE response framing", () => {
  test.each([
    ["LF", "\n", 0],
    ["CRLF", "\r\n", 0],
    ["CR", "\r", 0],
    ["CRLF split mid-delimiter", "\r\n", 3],
  ])(
    "reads a JSON-RPC message out of a %s event stream",
    async (_, eol, tail) => {
      const server = Bun.serve({
        port: 0,
        async fetch(req) {
          const parsedBody = RequestIdOnly(await req.json());
          if (parsedBody instanceof type.errors) {
            return new Response("bad request", { status: 400 });
          }
          const { id } = parsedBody;
          const body = new ReadableStream({
            start(controller) {
              const enc = new TextEncoder();
              const frame = `event: message${eol}data: ${JSON.stringify({ jsonrpc: "2.0", id, result: { tools: [] } })}${eol}${eol}`;
              const cut = frame.length - tail;
              controller.enqueue(enc.encode(frame.slice(0, cut)));
              if (tail > 0) controller.enqueue(enc.encode(frame.slice(cut)));
              controller.close();
            },
          });
          return new Response(body, {
            headers: { "content-type": "text/event-stream" },
          });
        },
      });
      try {
        // The client mints its own request id starting from an internal
        // counter; rather than guess it, drive tools/list end to end and
        // assert on the parsed shape instead of a specific id.
        const tools = await mcpListTools(server.url.toString());
        expect(tools).toEqual([]);
      } finally {
        void server.stop(true);
      }
    },
  );
});

describe("bounded reads", () => {
  const enc = new TextEncoder();
  function sseServer(body: () => ReadableStream) {
    return Bun.serve({
      port: 0,
      fetch: () =>
        new Response(body(), {
          headers: { "content-type": "text/event-stream" },
        }),
    });
  }

  test("an endless stream is cut off by the timeout and cancelled", async () => {
    let cancelled = false;
    const server = sseServer(
      () =>
        new ReadableStream({
          async pull(controller) {
            await Bun.sleep(20);
            controller.enqueue(enc.encode(": keepalive\n\n"));
          },
          cancel() {
            cancelled = true;
          },
        }),
    );
    try {
      await expect(
        mcpListTools(server.url.toString(), { timeoutMs: 200 }),
      ).rejects.toThrow(/within 200ms/);
      await Bun.sleep(50);
      expect(cancelled).toBe(true);
    } finally {
      void server.stop(true);
    }
  });

  test("a stalled server is cut off by the timeout", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        await Bun.sleep(5_000);
        return new Response("{}");
      },
    });
    try {
      await expect(
        mcpListTools(server.url.toString(), { timeoutMs: 200 }),
      ).rejects.toThrow(/within 200ms/);
    } finally {
      void server.stop(true);
    }
  });

  test("an oversized frame is refused and the stream cancelled", async () => {
    let sent = 0;
    let cancelled = false;
    const server = sseServer(
      () =>
        new ReadableStream({
          pull(controller) {
            sent += 1;
            if (sent > 64) return controller.close();
            controller.enqueue(enc.encode(`data: ${"x".repeat(1 << 20)}`));
          },
          cancel() {
            cancelled = true;
          },
        }),
    );
    try {
      await expect(mcpListTools(server.url.toString())).rejects.toThrow(
        /larger than/,
      );
      await Bun.sleep(50);
      expect(cancelled).toBe(true);
      expect(sent).toBeLessThan(64);
    } finally {
      void server.stop(true);
    }
  });

  test("an oversized JSON body is refused", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(`"${"x".repeat(5 * 1024 * 1024)}"`, {
          headers: { "content-type": "application/json" },
        }),
    });
    try {
      await expect(mcpListTools(server.url.toString())).rejects.toThrow(
        /larger than/,
      );
    } finally {
      void server.stop(true);
    }
  });

  test("the stream is cancelled once the matching frame is read", async () => {
    let cancelled = false;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const parsed = RequestIdOnly(await req.json());
        if (parsed instanceof type.errors)
          return new Response("", { status: 400 });
        const frame = `data: ${JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { tools: [] } })}\n\n`;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(enc.encode(frame));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    try {
      expect(await mcpListTools(server.url.toString())).toEqual([]);
      await Bun.sleep(50);
      expect(cancelled).toBe(true);
    } finally {
      void server.stop(true);
    }
  });
});
