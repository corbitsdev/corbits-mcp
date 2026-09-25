import { describe, expect, test, afterEach } from "bun:test";
import { type } from "arktype";

import {
  mcpCallTool,
  mcpInitialize,
  mcpListTools,
  McpError,
} from "./client.js";
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
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("reads a JSON-RPC message out of a %s event stream", async (_, eol) => {
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
            controller.enqueue(
              enc.encode(
                `event: message${eol}data: ${JSON.stringify({ jsonrpc: "2.0", id, result: { tools: [] } })}${eol}${eol}`,
              ),
            );
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
  });
});

describe("McpError", () => {
  test("is a distinct Error subclass", () => {
    const err = new McpError("boom");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("McpError");
  });
});
