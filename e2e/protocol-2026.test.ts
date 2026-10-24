// A small 2026-07-28 fixture. The SDK devDependency speaks the 2025 transports
// and is covered by sdk-transport.test.ts.

import { afterEach, describe, expect, test } from "bun:test";

import { discoverMcpServer } from "../src/hub/discover.js";

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
});

describe("hub discovery against protocol 2026-07-28", () => {
  test("reads the catalog without initialize and keeps outputSchema and title", async () => {
    const methods: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as {
          id?: number;
          method?: string;
          params?: { _meta?: Record<string, unknown> };
        };
        methods.push(String(body.method));
        if (body.method === "server/discover") {
          const capabilities =
            body.params?._meta?.["io.modelcontextprotocol/clientCapabilities"];
          expect(capabilities).toEqual({});
          expect(req.headers.get("mcp-protocol-version")).toBe("2026-07-28");
          expect(req.headers.has("mcp-session-id")).toBe(false);
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              supportedVersions: ["2026-07-28"],
              capabilities: { tools: {} },
              _meta: {
                "io.modelcontextprotocol/serverInfo": {
                  name: "era",
                  version: "1",
                },
              },
            },
          });
        }
        if (body.method === "tools/list") {
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              tools: [
                {
                  name: "echo",
                  description: "Echo.",
                  inputSchema: { type: "object" },
                  outputSchema: {
                    type: "object",
                    unevaluatedProperties: false,
                  },
                  annotations: { title: "Echo title", readOnlyHint: true },
                },
              ],
              ttlMs: 15,
              cacheScope: "private",
            },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    stop = () => void server.stop(true);
    const found = await discoverMcpServer({ url: server.url.toString() });
    expect(methods).toEqual(["server/discover", "tools/list"]);
    expect(found.serverInfo).toEqual({
      protocolVersion: "2026-07-28",
      serverInfo: { name: "era", version: "1" },
    });
    expect(found.tools[0]?.outputSchema).toEqual({
      type: "object",
      unevaluatedProperties: false,
    });
    expect(found.tools[0]?.annotations?.title).toBe("Echo title");
    expect(found.ttlMs).toBe(15);
    expect(found.cacheScope).toBe("private");
  });
});
