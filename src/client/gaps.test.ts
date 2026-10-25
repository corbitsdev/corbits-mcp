import { describe, expect, test } from "bun:test";
import {
  mcpConnect,
  mcpGetTask,
  mcpGetPrompt,
  mcpListen,
  mcpReadResource,
  mcpReadResourceDirectory,
  createMcpRequestTransport,
  MCP_EXT_SKILLS,
  McpError,
  MCP_EXT_TASKS,
  MCP_PROTOCOL_VERSION,
  mcpCallTool,
} from "../client";
import type { FetchLike } from "../protocol/types";
const url = "https://example.test/mcp";
function reply(
  result: unknown,
  inspect?: (body: Record<string, unknown>, headers: Headers) => void,
): FetchLike {
  return async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    inspect?.(body, new Headers(init?.headers));
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  };
}
const task = {
  resultType: "task",
  taskId: "t",
  status: "working",
  createdAt: "2026-01-01T00:00:00Z",
  lastUpdatedAt: "2026-01-01T00:00:00Z",
  ttlMs: null,
};
describe("shared client audit regressions", () => {
  test("task RPC names mirror taskId", async () => {
    await mcpGetTask(url, "task/日本語", {
      extensions: [MCP_EXT_TASKS],
      fetch: reply({ ...task, resultType: "complete" }, (_body, headers) => {
        expect(headers.get("Mcp-Name")).toBe(
          `=?base64?${Buffer.from("task/日本語").toString("base64")}?=`,
        );
      }),
    });
  });
  test("tasks cannot replace prompt results", async () => {
    await expect(
      mcpGetPrompt(url, "p", undefined, {
        extensions: [MCP_EXT_TASKS],
        fetch: reply(task),
      }),
    ).rejects.toBeInstanceOf(McpError);
  });
  test("modern polymorphic results are rejected on legacy sessions", async () => {
    await expect(
      mcpCallTool(
        url,
        "t",
        {},
        {
          session: { protocolVersion: "2025-03-26" },
          extensions: [MCP_EXT_TASKS],
          fetch: reply(task),
        },
      ),
    ).rejects.toBeInstanceOf(McpError);
  });
  test("subscription termination validates resultType", async () => {
    await expect(
      mcpListen(url, {}, () => {}, { fetch: reply({ resultType: "mystery" }) }),
    ).rejects.toBeInstanceOf(McpError);
  });
  test("401 challenge wins over an RPC fallback error", async () => {
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls++;
      return Response.json(
        { error: { code: -32601, message: "server not initialized" } },
        {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer resource_metadata="https://example.test/meta"',
          },
        },
      );
    };
    try {
      await mcpConnect(url, { fetch });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(McpError);
      const failure = error as McpError & { wwwAuthenticate?: string };
      expect(failure.status).toBe(401);
      expect(failure.wwwAuthenticate).toContain("resource_metadata");
      expect(calls).toBe(1);
    }
  });
  test("error responses must match the request ID", async () => {
    const fetch: FetchLike = async () =>
      Response.json({
        jsonrpc: "2.0",
        id: "other",
        error: { code: -32601, message: "wrong request" },
      });
    await expect(mcpConnect(url, { fetch })).rejects.toThrow(
      "malformed response",
    );
  });
  test("resource result metadata survives projection", async () => {
    const result = await mcpReadResource(url, "test://a", {
      fetch: reply({
        resultType: "complete",
        contents: [{ uri: "test://a", text: "a" }],
        _meta: { "example/trace": "trace" },
      }),
    });
    expect(result).toHaveProperty("_meta", { "example/trace": "trace" });
  });
  test("structured output is checked against an explicitly supplied schema", async () => {
    await expect(
      mcpCallTool(
        url,
        "t",
        {},
        {
          fetch: reply({ content: [], structuredContent: { count: "bad" } }),
          outputSchema: {
            type: "object",
            properties: { count: { type: "integer" } },
            required: ["count"],
          },
        },
      ),
    ).rejects.toBeInstanceOf(McpError);
  });
  test("subscription ack, notifications, and termination share one identity", async () => {
    const fetch: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { id: number };
      const _meta = { "io.modelcontextprotocol/subscriptionId": body.id };
      const messages = [
        {
          jsonrpc: "2.0",
          method: "notifications/subscriptions/acknowledged",
          params: { notifications: { toolsListChanged: true }, _meta },
        },
        {
          jsonrpc: "2.0",
          method: "notifications/tools/list_changed",
          params: { _meta },
        },
        {
          jsonrpc: "2.0",
          id: body.id,
          result: { resultType: "complete", _meta },
        },
      ];
      return new Response(
        messages
          .map((message) => `data: ${JSON.stringify(message)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    const notes: string[] = [];
    await mcpListen(
      url,
      { toolsListChanged: true },
      (note) => notes.push(note.method),
      { fetch },
    );
    expect(notes).toEqual([
      "notifications/subscriptions/acknowledged",
      "notifications/tools/list_changed",
    ]);
  });
  test("subscription notification before ack is rejected", async () => {
    const fetch: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { id: number };
      return new Response(
        `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: { _meta: { "io.modelcontextprotocol/subscriptionId": body.id } } })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    await expect(
      mcpListen(url, { toolsListChanged: true }, () => {}, { fetch }),
    ).rejects.toThrow("preceded acknowledgement");
  });
  test("default stateless calls still use modern protocol", async () => {
    await mcpCallTool(
      url,
      "t",
      {},
      {
        fetch: reply({ content: [] }, (_body, headers) =>
          expect(headers.get("MCP-Protocol-Version")).toBe(
            MCP_PROTOCOL_VERSION,
          ),
        ),
      },
    );
  });
});

describe("discovered directory capabilities", () => {
  for (const directoryRead of [true, false, undefined]) {
    test(`directoryRead=${String(directoryRead)} gates facade and transport`, async () => {
      const methods: unknown[] = [];
      const resources = [{ uri: "skill://demo/SKILL.md", name: "SKILL.md" }];
      const fetch: FetchLike = async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        methods.push(body.method);
        const result =
          body.method === "server/discover"
            ? {
                supportedVersions: [MCP_PROTOCOL_VERSION],
                capabilities: {
                  resources: {},
                  extensions: {
                    [MCP_EXT_SKILLS]:
                      directoryRead === undefined ? {} : { directoryRead },
                  },
                },
              }
            : { resources };
        return Response.json({ jsonrpc: "2.0", id: body.id, result });
      };
      const session = await mcpConnect(url, {
        fetch,
        extensions: [MCP_EXT_SKILLS],
      });
      const opts = { fetch, session };
      const transport = createMcpRequestTransport(url, opts);
      if (directoryRead === true) {
        expect(
          await mcpReadResourceDirectory(url, "skill://demo/", opts),
        ).toEqual(resources);
        expect(
          await transport.request("resources/directory/read", {
            uri: "skill://demo/",
          }),
        ).toEqual({ resources });
        expect(methods).toEqual([
          "server/discover",
          "resources/directory/read",
          "resources/directory/read",
        ]);
      } else {
        await expect(
          mcpReadResourceDirectory(url, "skill://demo/", opts),
        ).rejects.toThrow("directoryRead");
        await expect(
          transport.request("resources/directory/read", {
            uri: "skill://demo/",
          }),
        ).rejects.toThrow("directoryRead");
        expect(methods).toEqual(["server/discover"]);
      }
    });
  }
});
