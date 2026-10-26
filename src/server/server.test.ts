import { describe, expect, test } from "bun:test";
import { createMcpServer, createToolProviders } from "../server.js";
import { mcpCallTool, mcpConnect, mcpListTools } from "../client.js";
import type { McpAuthPolicy } from "../auth/contracts.js";
import type { FetchLike } from "../protocol/types.js";

const identity = {
  tenantId: "tenant",
  principalId: "principal",
  authorizationContextId: "grant-v1",
  scopes: [],
};
const auth: McpAuthPolicy = {
  authenticate: () => identity,
  authorize: () => true,
};
const info = { name: "fixture", version: "1" };
import { rpc, result } from "./fixtures.js";

describe("stateless MCP server", () => {
  test("real client discovers, lists and calls with no session", async () => {
    const server = createMcpServer({
      serverInfo: info,
      auth: "public",
      providers: createToolProviders(
        [
          {
            definition: {
              name: "echo",
              inputSchema: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
                additionalProperties: false,
              },
            },
            resource: "tool:echo",
            action: "call",
            execute: (args) => ({
              content: [{ type: "text", text: args.value }],
            }),
          },
        ],
        "public",
      ),
    });
    const fetch: FetchLike = (input, init) =>
      server.fetch(
        input instanceof Request
          ? new Request(input, init)
          : new Request(String(input), init),
      );
    const session = await mcpConnect("http://localhost/mcp", { fetch });
    expect(
      (await mcpListTools("http://localhost/mcp", { fetch, session }))[0]?.name,
    ).toBe("echo");
    expect(
      await mcpCallTool(
        "http://localhost/mcp",
        "echo",
        { value: "hello" },
        { fetch, session },
      ),
    ).toMatchObject({ content: [{ type: "text", text: "hello" }] });
    expect(
      (await server.fetch(rpc("server/discover"))).headers.get(
        "Mcp-Session-Id",
      ),
    ).toBeNull();
    await server.close();
  });

  test("rejects Origin, unauthenticated identity, header mismatch and malformed JSON", async () => {
    const server = createMcpServer({ serverInfo: info, auth });
    expect(
      (
        await server.fetch(
          rpc("server/discover", {}, { Origin: "https://evil.example" }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await server.fetch(
          rpc("server/discover", {}, { "Mcp-Method": "tools/list" }),
        )
      ).status,
    ).toBe(400);
    const denied = createMcpServer({
      serverInfo: info,
      auth: { ...auth, authenticate: () => null },
    });
    expect((await denied.fetch(rpc("server/discover"))).status).toBe(401);
    const malformed = rpc("server/discover");
    expect(
      (
        await server.fetch(
          new Request(malformed.url, {
            method: "POST",
            headers: malformed.headers,
            body: "[",
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await server.fetch(new Request("http://localhost/mcp"))).status,
    ).toBe(405);
    await server.close();
    await denied.close();
  });

  test("invalid arguments and denied grants never execute providers", async () => {
    let calls = 0;
    let granted = true;
    const policy = { ...auth, authorize: () => granted };
    const server = createMcpServer({
      serverInfo: info,
      auth: policy,
      providers: createToolProviders(
        [
          {
            definition: {
              name: "integer",
              inputSchema: {
                type: "object",
                properties: { count: { type: "integer" } },
                required: ["count"],
              },
            },
            resource: "tool:integer",
            action: "call",
            execute: () => {
              calls++;
              return { content: [] };
            },
          },
        ],
        policy,
      ),
    });
    expect(
      await result(
        await server.fetch(
          rpc("tools/call", { name: "integer", arguments: { count: "wrong" } }),
        ),
      ),
    ).toHaveProperty("error");
    granted = false;
    expect(
      (
        await server.fetch(
          rpc("tools/call", { name: "integer", arguments: { count: 1 } }),
        )
      ).status,
    ).toBe(403);
    expect(calls).toBe(0);
    await server.close();
  });

  test("streams scoped progress and aborts provider when response is cancelled", async () => {
    let cancelled = false;
    const server = createMcpServer({
      serverInfo: info,
      auth: "public",
      providers: {
        "tools/call": {
          resource: "tool:work",
          action: "call",
          async handle(_params, context) {
            context.reportProgress(1, 2, "started");
            await new Promise<void>((resolve) =>
              context.signal.addEventListener(
                "abort",
                () => {
                  cancelled = true;
                  resolve();
                },
                { once: true },
              ),
            );
            return { content: [] };
          },
        },
      },
    });
    const response = await server.fetch(
      rpc("tools/call", {
        name: "work",
        _meta: { progressToken: "progress-1" },
      }),
    );
    const reader = response.body!.getReader();
    const event = new TextDecoder().decode((await reader.read()).value);
    expect(event).toContain('"method":"notifications/progress"');
    expect(event).toContain('"progressToken":"progress-1"');
    await reader.cancel();
    expect(cancelled).toBe(true);
    await server.close();
  });

  test("rejects unknown providers and disabled extensions", () => {
    const provider = { resource: "x", action: "read", handle: () => ({}) };
    expect(() =>
      createMcpServer({
        serverInfo: info,
        auth: "public",
        providers: { "fake/method": provider },
      }),
    ).toThrow();
    expect(() =>
      createMcpServer({
        serverInfo: info,
        auth: "public",
        providers: { "tasks/get": provider },
      }),
    ).toThrow();
  });
});

test("unknown methods use HTTP 404 and unsupported versions list supported revisions", async () => {
  const server = createMcpServer({ serverInfo: info, auth: "public" });
  expect((await server.fetch(rpc("unknown/method"))).status).toBe(404);
  const request = rpc(
    "server/discover",
    { _meta: { "io.modelcontextprotocol/protocolVersion": "2025-11-25" } },
    { "MCP-Protocol-Version": "2025-11-25" },
  );
  const response = await server.fetch(request);
  expect(response.status).toBe(400);
  expect(await result(response)).toMatchObject({
    error: { code: -32022, data: { supported: ["2026-07-28"] } },
  });
  await server.close();
});

test("fetch handler serves real stateless loopback HTTP requests", async () => {
  const endpoint = createMcpServer({
    serverInfo: info,
    auth: "public",
    providers: createToolProviders(
      [
        {
          definition: { name: "network", inputSchema: { type: "object" } },
          resource: "tool:network",
          action: "call",
          execute: () => ({ content: [{ type: "text", text: "over HTTP" }] }),
        },
      ],
      "public",
    ),
  });
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: endpoint.fetch,
  });
  try {
    const url = `http://127.0.0.1:${listener.port}/mcp`;
    const session = await mcpConnect(url);
    expect(await mcpCallTool(url, "network", {}, { session })).toMatchObject({
      content: [{ text: "over HTTP" }],
    });
  } finally {
    await endpoint.close();
    await listener.stop(true);
  }
});

test("extension capability advertisements require corresponding providers", () => {
  expect(() =>
    createMcpServer({
      serverInfo: info,
      auth: "public",
      extensions: { "io.modelcontextprotocol/tasks": {} },
    }),
  ).toThrow();
  expect(() =>
    createMcpServer({
      serverInfo: info,
      auth: "public",
      extensions: { "io.modelcontextprotocol/skills": {} },
    }),
  ).toThrow();
});

test("denied authorize does not return server/discover", async () => {
  const seen: { resource: string; action: string }[] = [];
  const policy: McpAuthPolicy = {
    authenticate: () => identity,
    authorize: (_principal, operation) => {
      seen.push(operation);
      return false;
    },
  };
  const server = createMcpServer({
    serverInfo: info,
    auth: policy,
    providers: createToolProviders(
      [
        {
          definition: { name: "echo", inputSchema: { type: "object" } },
          resource: "tool:echo",
          action: "invoke",
          execute: () => ({ content: [] }),
        },
      ],
      "public",
    ),
  });
  const response = await server.fetch(rpc("server/discover"));
  expect(response.status).toBe(403);
  expect(await response.text()).not.toContain(info.name);
  expect(seen).toEqual([{ resource: "tool:echo", action: "invoke" }]);
  const empty = createMcpServer({ serverInfo: info, auth: policy });
  seen.length = 0;
  const bare = await empty.fetch(rpc("server/discover"));
  expect(bare.status).toBe(403);
  expect(await bare.text()).not.toContain(info.name);
  expect(seen).toEqual([{ resource: "mcp:server", action: "discover" }]);
  await server.close();
  await empty.close();
});

test("private server authorizes each tool binding when the provider auth is public", async () => {
  let executions = 0;
  const seen: string[] = [];
  let allow = true;
  const server = createMcpServer({
    serverInfo: info,
    auth: {
      authenticate: () => identity,
      authorize: (_principal, operation) => {
        seen.push(`${operation.resource} ${operation.action}`);
        return (
          allow &&
          operation.resource === "tool:echo" &&
          operation.action === "invoke"
        );
      },
    },
    providers: createToolProviders(
      [
        {
          definition: { name: "echo", inputSchema: { type: "object" } },
          resource: "tool:echo",
          action: "invoke",
          execute: () => {
            executions++;
            return { content: [{ type: "text", text: "ok" }] };
          },
        },
        {
          definition: { name: "other", inputSchema: { type: "object" } },
          resource: "tool:other",
          action: "invoke",
          execute: () => {
            executions++;
            return { content: [] };
          },
        },
      ],
      "public",
    ),
  });
  expect((await server.fetch(rpc("server/discover"))).status).toBe(200);
  expect(await result(await server.fetch(rpc("tools/list")))).toMatchObject({
    result: { tools: [{ name: "echo" }] },
  });
  expect(
    await result(
      await server.fetch(rpc("tools/call", { name: "echo", arguments: {} })),
    ),
  ).toMatchObject({ result: { content: [{ text: "ok" }] } });
  expect(executions).toBe(1);
  expect(
    seen.every(
      (entry) => entry === "tool:echo invoke" || entry === "tool:other invoke",
    ),
  ).toBe(true);
  allow = false;
  expect(await result(await server.fetch(rpc("tools/list")))).toMatchObject({
    result: { tools: [] },
  });
  expect(
    (await server.fetch(rpc("tools/call", { name: "echo", arguments: {} })))
      .status,
  ).toBe(403);
  expect(executions).toBe(1);
  await server.close();
});
