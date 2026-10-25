import { expect, test } from "bun:test";
import { ToolResult } from "@intx/types/runtime";
import { projectToolResult } from "./projection.js";
import type { McpHostContext } from "./contracts.js";
import type { McpInputRequired, McpTaskHandle } from "../../client.js";

const context: McpHostContext = {
  server: "srv",
  url: "https://example.test/mcp",
  tool: "srv.echo",
  callId: "c",
  signal: new AbortController().signal,
};
const pending: McpInputRequired = {
  resultType: "input_required",
  method: "tools/call",
  params: { name: "echo", arguments: {} },
  requestState: "opaque",
  inputRequests: {},
};
const task: McpTaskHandle = {
  resultType: "task",
  taskId: "t",
  status: "working",
  createdAt: "2026-01-01T00:00:00Z",
  lastUpdatedAt: "2026-01-01T00:00:00Z",
  ttlMs: null,
};

test("rich result retains structured content and private metadata in detail", async () => {
  const result = {
    content: [{ type: "text", text: "hello" }],
    structuredContent: { answer: 42 },
    _meta: { secretUiState: "private" },
  };
  const projected = await projectToolResult(context, result, {});
  expect(ToolResult.allows(projected)).toBe(true);
  expect(projected.content).toBe("hello");
  expect(projected.detail).toEqual({ mcp: result });
  expect(JSON.stringify(projected.content)).not.toContain("private");
});

test("absent lifecycle host reports unsupported without a fake pending marker", async () => {
  for (const result of [pending, task]) {
    const projected = await projectToolResult(context, result, {});
    expect(projected.isError).toBe(true);
    expect(projected.pendingMarker).toBeUndefined();
    expect(projected.detail).toEqual({ mcp: result, outcome: "unsupported" });
    expect(projected.content).not.toContain("opaque");
  }
});

test("declined input never invokes the remote continuation", async () => {
  const projected = await projectToolResult(
    context,
    pending,
    {},
    { requestInput: async () => undefined },
  );
  expect(projected.isError).toBe(true);
  expect(projected.detail).toEqual({ mcp: pending, outcome: "declined" });
});

test("only host-adopted tasks produce a real Interchange pending marker", async () => {
  const projected = await projectToolResult(
    context,
    task,
    {},
    {
      adoptTask: async (_context, received) => {
        expect(received).toEqual(task);
        return { correlationId: "durable-host-correlation" };
      },
    },
  );
  expect(ToolResult.allows(projected)).toBe(true);
  expect(projected.pendingMarker).toEqual({
    status: "pending",
    correlationId: "durable-host-correlation",
  });
  expect(projected.content).not.toContain("completed");
});

test("adopted task controls preserve the mediated transport and cooperative cancellation", async () => {
  const methods: string[] = [];
  const result = await projectToolResult(
    context,
    task,
    {
      extensions: ["io.modelcontextprotocol/tasks"],
      fetch: async (_input, init) => {
        const method = new Headers(init?.headers).get("mcp-method");
        methods.push(method ?? "");
        expect(new Headers(init?.headers).get("mcp-name")).toBe("t");
        const body: unknown = JSON.parse(String(init?.body));
        if (typeof body !== "object" || body === null || !("id" in body))
          throw new Error("Missing request ID");
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result:
            method === "tasks/get" ? { ...task, resultType: "complete" } : {},
        });
      },
    },
    {
      adoptTask: async (_context, _task, controls) => {
        expect((await controls.get()).status).toBe("working");
        await controls.update({});
        await controls.cancel();
        return { correlationId: "persisted" };
      },
    },
  );
  expect(methods).toEqual(["tasks/get", "tasks/update", "tasks/cancel"]);
  expect(result.pendingMarker?.correlationId).toBe("persisted");
});
