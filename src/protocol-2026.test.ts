import { describe, expect, test } from "bun:test";

import {
  MCP_EXT_SKILLS,
  MCP_EXT_TASKS,
  MCP_EXT_UI,
  MCP_PROTOCOL_VERSION,
  McpError,
  McpErrorCode,
  mcpCallTool,
  mcpCancelTask,
  mcpComplete,
  mcpConnect,
  mcpContinue,
  mcpGetPrompt,
  mcpGetSkill,
  mcpGetTask,
  mcpListPrompts,
  mcpListResourceTemplates,
  mcpListResources,
  mcpListSkills,
  mcpListTools,
  mcpListen,
  mcpReadResource,
  mcpReadResourceDirectory,
  mcpUpdateTask,
  type McpSession,
} from "./client.js";

type RpcBody = {
  id?: number | null;
  method?: string;
  params?: Record<string, unknown>;
};

type Seen = { method: string; headers: Headers; body: RpcBody };

function rpc(
  id: number | null | undefined,
  result: unknown,
  status = 200,
): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result }, { status });
}

function rpcError(
  id: number | null | undefined,
  code: number,
  message: string,
  data?: unknown,
  status = 200,
): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      id: id ?? null,
      error: {
        code,
        message,
        ...(data !== undefined ? { data } : {}),
      },
    },
    { status },
  );
}

function jsonServer(handler: (seen: Seen) => Response | Promise<Response>): {
  url: string;
  seen: Seen[];
  stop: () => void;
} {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as RpcBody;
      const entry = { method: String(body.method), headers: req.headers, body };
      seen.push(entry);
      return handler(entry);
    },
  });
  return {
    url: server.url.toString(),
    seen,
    stop: () => void server.stop(true),
  };
}

function meta(seen: Seen): Record<string, unknown> {
  const value = seen.body.params?._meta;
  if (typeof value !== "object" || value === null) {
    throw new Error("request is missing _meta");
  }
  return value as Record<string, unknown>;
}

const modern: McpSession = { protocolVersion: MCP_PROTOCOL_VERSION };

const META_PROTOCOL = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";

describe("MCP 2026-07-28", () => {
  test("discover opens a stateless session and later calls carry metadata and headers", async () => {
    const srv = jsonServer((seen) => {
      if (seen.method === "server/discover") {
        return rpc(seen.body.id, {
          supportedVersions: [MCP_PROTOCOL_VERSION, "2025-03-26"],
          capabilities: { tools: {} },
          instructions: "be brief",
          _meta: {
            "io.modelcontextprotocol/serverInfo": { name: "era", version: "1" },
          },
        });
      }
      if (seen.method === "tools/list") return rpc(seen.body.id, { tools: [] });
      return rpcError(seen.body.id, McpErrorCode.MethodNotFound, "no");
    });
    try {
      const session = await mcpConnect(srv.url);
      expect(session.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
      expect(session.sessionId).toBeUndefined();
      expect(session.serverInfo).toEqual({ name: "era", version: "1" });
      expect(session.instructions).toBe("be brief");
      await mcpListTools(srv.url, { session });
      expect(srv.seen.map((s) => s.method)).toEqual([
        "server/discover",
        "tools/list",
      ]);
      for (const seen of srv.seen) {
        expect(seen.headers.get("mcp-protocol-version")).toBe(
          MCP_PROTOCOL_VERSION,
        );
        expect(seen.headers.get("mcp-method")).toBe(seen.method);
        expect(seen.headers.has("mcp-session-id")).toBe(false);
        expect(seen.headers.get("accept")).toContain("application/json");
        expect(seen.headers.get("accept")).toContain("text/event-stream");
        const sent = meta(seen);
        expect(sent[META_PROTOCOL]).toBe(MCP_PROTOCOL_VERSION);
        expect(sent[META_CLIENT_INFO]).toEqual({
          name: "@corbits/mcp",
          version: "0.3.1",
        });
        expect(sent[META_CLIENT_CAPABILITIES]).toEqual({});
      }
    } finally {
      srv.stop();
    }
  });

  test("a core call with no session speaks the stateless protocol directly", async () => {
    const srv = jsonServer((seen) => {
      if (seen.method === "server/discover") {
        return rpc(seen.body.id, {
          supportedVersions: [MCP_PROTOCOL_VERSION],
          capabilities: { tools: {} },
        });
      }
      if (seen.method === "tools/list") return rpc(seen.body.id, { tools: [] });
      if (seen.method === "tools/call") {
        return rpc(seen.body.id, { resultType: "complete", content: "plain" });
      }
      return rpcError(seen.body.id, McpErrorCode.MethodNotFound, "no");
    });
    try {
      const tools = await mcpListTools(srv.url);
      expect(tools).toEqual([]);
      const result = await mcpCallTool(srv.url, "echo", { text: "hi" });
      expect(result.resultType).toBe("complete");
      if (result.resultType !== "complete")
        throw new Error("expected a complete result");
      expect(result.content).toBe("plain");

      for (const seen of srv.seen) {
        expect(seen.headers.get("MCP-Protocol-Version")).toBe(
          MCP_PROTOCOL_VERSION,
        );
        expect(seen.headers.get("Mcp-Method")).toBe(seen.method);
        expect(seen.headers.has("mcp-session-id")).toBe(false);
      }
      const call = srv.seen.find((entry) => entry.method === "tools/call");
      if (call === undefined) throw new Error("expected a tools/call");
      expect(call.headers.get("Mcp-Name")).toBe("echo");
      expect(meta(call)).toEqual({
        [META_PROTOCOL]: MCP_PROTOCOL_VERSION,
        [META_CLIENT_INFO]: { name: "@corbits/mcp", version: "0.3.1" },
        [META_CLIENT_CAPABILITIES]: {},
      });
    } finally {
      srv.stop();
    }
  });

  test("method-not-found, a legacy version list, and a timeout fall back to initialize", async () => {
    const notFound = jsonServer((seen) => {
      if (seen.method === "server/discover") {
        return rpcError(seen.body.id, McpErrorCode.MethodNotFound, "unknown");
      }
      if (seen.method === "initialize") {
        expect(seen.headers.has("mcp-protocol-version")).toBe(false);
        expect(seen.body.params?.protocolVersion).toBe("2025-03-26");
        return rpc(seen.body.id, {
          protocolVersion: "2025-03-26",
          capabilities: {},
        });
      }
      if (seen.body.id === undefined)
        return new Response(null, { status: 202 });
      return rpc(seen.body.id, { tools: [] });
    });
    try {
      const session = await mcpConnect(notFound.url);
      expect(session).toEqual({ protocolVersion: "2025-03-26" });
      expect(notFound.seen.map((s) => s.method)).toEqual([
        "server/discover",
        "initialize",
        "notifications/initialized",
      ]);
    } finally {
      notFound.stop();
    }

    const legacy = jsonServer((seen) => {
      if (seen.method === "server/discover") {
        return rpc(seen.body.id, {
          supportedVersions: ["2025-11-25"],
          capabilities: {},
        });
      }
      if (seen.method === "initialize") {
        expect(seen.body.params?.protocolVersion).toBe("2025-11-25");
        expect(seen.headers.has("mcp-protocol-version")).toBe(false);
        return rpc(seen.body.id, { protocolVersion: "2025-11-25" });
      }
      if (seen.body.id === undefined)
        return new Response(null, { status: 202 });
      return rpc(seen.body.id, {});
    });
    try {
      const session = await mcpConnect(legacy.url);
      expect(session.protocolVersion).toBe("2025-11-25");
    } finally {
      legacy.stop();
    }

    let discoverHung = false;
    const slow = jsonServer((seen) => {
      if (!discoverHung) {
        discoverHung = true;
        return new Promise(() => undefined);
      }
      if (seen.method === "initialize") {
        return rpc(seen.body.id, { protocolVersion: "2025-03-26" });
      }
      if (seen.body.id === undefined)
        return new Response(null, { status: 202 });
      return rpc(seen.body.id, {});
    });
    try {
      const session = await mcpConnect(slow.url, { timeoutMs: 30 });
      expect(session.protocolVersion).toBe("2025-03-26");
      expect(slow.seen.map((entry) => entry.method)).toContain("initialize");
    } finally {
      slow.stop();
    }
  });

  test("authz, rate-limit, server, and malformed discover errors do not fall back", async () => {
    const failures: Array<{ status: number; body: string }> = [
      { status: 403, body: "forbidden" },
      { status: 429, body: "slow down" },
      { status: 503, body: "boom" },
      { status: 200, body: "not json" },
    ];
    for (const { status, body } of failures) {
      const srv = jsonServer(() => new Response(body, { status }));
      try {
        const failure = await mcpConnect(srv.url).catch(
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(McpError);
        expect(srv.seen.map((s) => s.method)).toEqual(["server/discover"]);
        expect((failure as McpError).status).toBe(
          status === 200 ? undefined : status,
        );
      } finally {
        srv.stop();
      }
    }
  });

  test("header mismatch and an unsupported modern version do not fall back", async () => {
    const mismatch = jsonServer((seen) =>
      rpcError(
        seen.body.id,
        McpErrorCode.HeaderMismatch,
        "header",
        undefined,
        400,
      ),
    );
    try {
      const failure = await mcpConnect(mismatch.url).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(McpError);
      expect((failure as McpError).code).toBe(McpErrorCode.HeaderMismatch);
      expect(mismatch.seen.map((s) => s.method)).toEqual(["server/discover"]);
    } finally {
      mismatch.stop();
    }

    const unsupported = jsonServer(() =>
      rpcError(
        null,
        McpErrorCode.UnsupportedProtocolVersion,
        "version",
        { supported: [MCP_PROTOCOL_VERSION], requested: MCP_PROTOCOL_VERSION },
        400,
      ),
    );
    try {
      const failure = await mcpConnect(unsupported.url).catch(
        (error: unknown) => error,
      );
      expect((failure as McpError).code).toBe(
        McpErrorCode.UnsupportedProtocolVersion,
      );
      expect(unsupported.seen).toHaveLength(1);
    } finally {
      unsupported.stop();
    }

    const downgrade = jsonServer((seen) => {
      if (seen.method === "server/discover") {
        return rpcError(
          seen.body.id,
          McpErrorCode.UnsupportedProtocolVersion,
          "version",
          {
            supported: ["2025-06-18"],
          },
        );
      }
      if (seen.method === "initialize") {
        expect(seen.body.params?.protocolVersion).toBe("2025-06-18");
        return rpc(seen.body.id, { protocolVersion: "2025-06-18" });
      }
      return new Response(null, { status: 202 });
    });
    try {
      const session = await mcpConnect(downgrade.url);
      expect(session.protocolVersion).toBe("2025-06-18");
    } finally {
      downgrade.stop();
    }
  });

  test("surfaces standard and modern JSON-RPC codes", async () => {
    const codes = [
      McpErrorCode.ParseError,
      McpErrorCode.InvalidRequest,
      McpErrorCode.InvalidParams,
      McpErrorCode.InternalError,
      McpErrorCode.MissingRequiredClientCapability,
    ];
    for (const code of codes) {
      const srv = jsonServer((seen) =>
        rpcError(seen.body.id, code, `code ${String(code)}`),
      );
      try {
        const failure = await mcpListTools(srv.url, { session: modern }).catch(
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(McpError);
        expect((failure as McpError).code).toBe(code);
      } finally {
        srv.stop();
      }
    }
  });

  test("a missing resultType is complete, and input_required retries the same method", async () => {
    let call = 0;
    const srv = jsonServer((seen) => {
      call += 1;
      if (call === 1) return rpc(seen.body.id, { content: "plain" });
      if (call === 2) {
        return rpc(seen.body.id, {
          resultType: "input_required",
          requestState: "opaque",
          inputRequests: {
            a: { method: "elicitation/create", message: "name" },
          },
        });
      }
      expect(seen.body.params?.inputResponses).toEqual({ a: { text: "ada" } });
      expect(seen.body.params?.requestState).toBe("opaque");
      expect(seen.body.params?.name).toBe("echo");
      expect(seen.headers.get("mcp-name")).toBe("echo");
      return rpc(seen.body.id, { resultType: "complete", content: "ada" });
    });
    try {
      const first = await mcpCallTool(
        srv.url,
        "echo",
        { text: "hi" },
        { session: modern },
      );
      expect(first).toMatchObject({ resultType: "complete", content: "plain" });
      const pending = await mcpCallTool(
        srv.url,
        "echo",
        { text: "hi" },
        { session: modern },
      );
      expect(pending.resultType).toBe("input_required");
      if (pending.resultType !== "input_required")
        throw new Error("expected input");
      const continued = await mcpContinue(
        srv.url,
        pending,
        { a: { text: "ada" } },
        {
          session: modern,
        },
      );
      expect(continued).toMatchObject({
        resultType: "complete",
        content: "ada",
      });
    } finally {
      srv.stop();
    }
  });

  test("follows cursors, including an empty one, and keeps cache fields", async () => {
    let page = 0;
    const srv = jsonServer((seen) => {
      page += 1;
      if (page === 1) {
        expect(seen.body.params?.cursor).toBeUndefined();
        return rpc(seen.body.id, {
          tools: [{ name: "one", inputSchema: { type: "object" } }],
          nextCursor: "",
          ttlMs: 100,
          cacheScope: "public",
        });
      }
      expect(seen.body.params?.cursor).toBe("");
      return rpc(seen.body.id, {
        tools: [
          {
            name: "two",
            title: "Two",
            inputSchema: {
              $schema: "https://json-schema.org/draft/2020-12/schema",
              type: "object",
              unevaluatedProperties: false,
              prefixItems: [{ type: "string" }],
            },
            outputSchema: { type: "object", unevaluatedProperties: true },
            annotations: {
              title: "Two title",
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false,
            },
            _meta: { "ui/resourceUri": "ui://two" },
          },
        ],
        ttlMs: 40,
        cacheScope: "public",
      });
    });
    try {
      const tools = await mcpListTools(srv.url, { session: modern });
      expect(tools.map((tool) => tool.name)).toEqual(["one", "two"]);
      expect(tools.ttlMs).toBe(40);
      expect(tools.cacheScope).toBe("public");
      expect(Object.keys(tools)).toEqual(["0", "1"]);
      expect(JSON.stringify(tools)).not.toContain("ttlMs");
      const two = tools[1];
      expect(two?.title).toBe("Two");
      expect(two?.annotations?.title).toBe("Two title");
      expect(two?.outputSchema).toMatchObject({ unevaluatedProperties: true });
      expect(two?.inputSchema).toMatchObject({
        unevaluatedProperties: false,
        prefixItems: [{ type: "string" }],
      });
      expect(two?._meta).toEqual({ "ui/resourceUri": "ui://two" });
    } finally {
      srv.stop();
    }
  });

  test("drops a tool whose x-mcp-header is not a primitive and mirrors a valid one", async () => {
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (message?: unknown) => {
      warned.push(String(message));
    };
    const srv = jsonServer((seen) => {
      if (seen.method === "tools/list") {
        return rpc(seen.body.id, {
          tools: [
            {
              name: "bad",
              inputSchema: {
                type: "object",
                properties: { n: { type: "number", "x-mcp-header": "N" } },
              },
            },
            {
              name: "good",
              inputSchema: {
                type: "object",
                properties: {
                  note: { type: "string", "x-mcp-header": "Note" },
                },
              },
            },
          ],
        });
      }
      expect(seen.headers.get("mcp-param-note")).toMatch(/^=\?base64\?.+\?=$/);
      return rpc(seen.body.id, { content: "ok" });
    });
    try {
      const tools = await mcpListTools(srv.url, { session: modern });
      expect(tools.map((tool) => tool.name)).toEqual(["good"]);
      expect(warned.some((line) => line.includes("bad"))).toBe(true);
      const good = tools[0];
      if (good === undefined) throw new Error("missing tool");
      const result = await mcpCallTool(
        srv.url,
        "good",
        { note: "héllo" },
        { session: modern, inputSchema: good.inputSchema },
      );
      expect(result).toMatchObject({ resultType: "complete", content: "ok" });
    } finally {
      console.warn = original;
      srv.stop();
    }
  });

  test("lists and reads prompts, resources, templates, and completions", async () => {
    let promptPage = 0;
    const fixed = jsonServer((seen) => {
      if (seen.method === "prompts/list") {
        promptPage += 1;
        return promptPage === 1
          ? rpc(seen.body.id, {
              prompts: [{ name: "greet" }],
              nextCursor: "p2",
            })
          : rpc(seen.body.id, { prompts: [{ name: "later" }] });
      }
      if (seen.method === "prompts/get") {
        expect(seen.headers.get("mcp-name")).toBe("greet");
        return rpc(seen.body.id, {
          description: "hi",
          messages: [{ role: "user" }],
        });
      }
      if (seen.method === "resources/list") {
        return rpc(seen.body.id, {
          resources: [
            { uri: "file://a", name: "a", _meta: { ui: { csp: {} } } },
          ],
        });
      }
      if (seen.method === "resources/read") {
        expect(seen.headers.get("mcp-name")).toBe("file://a");
        return rpc(seen.body.id, {
          contents: [{ uri: "file://a", text: "body" }],
          ttlMs: 5,
          cacheScope: "private",
        });
      }
      if (seen.method === "resources/templates/list") {
        return rpc(seen.body.id, {
          resourceTemplates: [{ uriTemplate: "file://{id}", name: "file" }],
        });
      }
      if (seen.method === "completion/complete") {
        expect(seen.body.params?.ref).toEqual({
          type: "ref/prompt",
          name: "greet",
        });
        return rpc(seen.body.id, {
          completion: { values: ["ada"], hasMore: false },
        });
      }
      return rpcError(seen.body.id, McpErrorCode.MethodNotFound, seen.method);
    });
    try {
      const prompts = await mcpListPrompts(fixed.url, { session: modern });
      expect(prompts.map((prompt) => prompt.name)).toEqual(["greet", "later"]);
      const prompt = await mcpGetPrompt(
        fixed.url,
        "greet",
        { name: "ada" },
        { session: modern },
      );
      expect(prompt).toMatchObject({
        resultType: "complete",
        description: "hi",
      });
      const resources = await mcpListResources(fixed.url, { session: modern });
      expect(resources[0]?._meta).toEqual({ ui: { csp: {} } });
      const read = await mcpReadResource(fixed.url, "file://a", {
        session: modern,
      });
      expect(read).toMatchObject({
        resultType: "complete",
        ttlMs: 5,
        cacheScope: "private",
      });
      const templates = await mcpListResourceTemplates(fixed.url, {
        session: modern,
      });
      expect(templates[0]?.uriTemplate).toBe("file://{id}");
      const completion = await mcpComplete(
        fixed.url,
        { type: "ref/prompt", name: "greet" },
        { name: "name", value: "a" },
        { session: modern },
      );
      expect(completion.completion.values).toEqual(["ada"]);
    } finally {
      fixed.stop();
    }
  });

  test("caller abort sends notifications/cancelled and a timeout does not", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const live = jsonServer(async (seen) => {
      if (seen.body.id === undefined)
        return new Response(null, { status: 202 });
      await gate;
      return rpc(seen.body.id, { content: "late" });
    });
    try {
      const ac = new AbortController();
      const pending = mcpCallTool(
        live.url,
        "echo",
        {},
        { session: modern, signal: ac.signal },
      );
      while (live.seen.length === 0) await Bun.sleep(5);
      ac.abort();
      release?.();
      const failure = await pending.catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(McpError);
      expect((failure as McpError).cancelled).toBe(true);
      for (
        let i = 0;
        i < 20 &&
        !live.seen.some((s) => s.method === "notifications/cancelled");
        i++
      ) {
        await Bun.sleep(10);
      }
      const note = live.seen.find(
        (s) => s.method === "notifications/cancelled",
      );
      expect(note?.body.params?.reason).toBe("the caller aborted the request");
      expect(note?.headers.get("mcp-method")).toBe("notifications/cancelled");
    } finally {
      live.stop();
    }

    const stalled = jsonServer(() => new Promise(() => undefined));
    try {
      const failure = await mcpCallTool(
        stalled.url,
        "echo",
        {},
        {
          session: modern,
          timeoutMs: 40,
        },
      ).catch((error: unknown) => error);
      expect((failure as McpError).timedOut).toBe(true);
      await Bun.sleep(30);
      expect(stalled.seen.map((s) => s.method)).toEqual(["tools/call"]);
    } finally {
      stalled.stop();
    }
  });

  test("progress stays on the call stream and subscriptions/listen closes on abort", async () => {
    const progress: number[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as RpcBody;
        const enc = new TextEncoder();
        const token = (
          body.params?._meta as { progressToken?: number } | undefined
        )?.progressToken;
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(
              enc.encode(
                `data: ${JSON.stringify({
                  jsonrpc: "2.0",
                  method: "notifications/progress",
                  params: {
                    progressToken: token,
                    progress: 1,
                    total: 2,
                    message: "go",
                  },
                })}\n\n`,
              ),
            );
            controller.enqueue(
              enc.encode(
                `data: ${JSON.stringify({
                  jsonrpc: "2.0",
                  id: body.id,
                  result: { content: "done" },
                })}\n\n`,
              ),
            );
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    try {
      const result = await mcpCallTool(
        server.url.toString(),
        "echo",
        {},
        {
          session: modern,
          onProgress: (update) => progress.push(update.progress),
        },
      );
      expect(progress).toEqual([1]);
      expect(result).toMatchObject({ resultType: "complete", content: "done" });
    } finally {
      void server.stop(true);
    }

    const notes: string[] = [];
    let listenId: number | undefined;
    const ac = new AbortController();
    const listen = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as RpcBody;
        if (body.id === undefined) return new Response(null, { status: 202 });
        listenId = body.id ?? undefined;
        const enc = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            const ack = {
              jsonrpc: "2.0",
              method: "notifications/subscriptions/acknowledged",
              params: {
                _meta: { "io.modelcontextprotocol/subscriptionId": body.id },
              },
            };
            controller.enqueue(
              enc.encode(`: keepalive\n\ndata: ${JSON.stringify(ack)}\n\n`),
            );
            controller.enqueue(
              enc.encode(
                `data: ${JSON.stringify({
                  jsonrpc: "2.0",
                  method: "notifications/tools/list_changed",
                })}\n\n`,
              ),
            );
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    try {
      const pending = mcpListen(
        listen.url.toString(),
        { toolsListChanged: true },
        (notification) => notes.push(notification.method),
        { signal: ac.signal },
      );
      for (let i = 0; i < 50 && notes.length < 2; i++) await Bun.sleep(10);
      expect(notes).toEqual([
        "notifications/subscriptions/acknowledged",
        "notifications/tools/list_changed",
      ]);
      expect(listenId).toEqual(expect.any(Number));
      ac.abort();
      const failure = await pending.catch((error: unknown) => error);
      expect((failure as McpError).cancelled).toBe(true);
    } finally {
      void listen.stop(true);
    }
  });

  test("tasks, UI metadata, and skills stay off unless the extension id is enabled", async () => {
    const srv = jsonServer((seen) => {
      if (seen.method === "tools/call") {
        const capabilities = meta(seen)[META_CLIENT_CAPABILITIES] as {
          extensions?: Record<string, unknown>;
        };
        if (capabilities.extensions?.[MCP_EXT_TASKS] !== undefined) {
          return rpc(seen.body.id, {
            resultType: "task",
            taskId: "t1",
            status: "working",
            createdAt: "2026-07-28T00:00:00Z",
            lastUpdatedAt: "2026-07-28T00:00:00Z",
            ttlMs: 1000,
          });
        }
        return rpc(seen.body.id, {
          content: "ui",
          _meta: { ui: { resourceUri: "ui://app" } },
        });
      }
      if (seen.method === "tasks/get") {
        return rpc(seen.body.id, {
          resultType: "complete",
          taskId: "t1",
          status: "completed",
          createdAt: "2026-07-28T00:00:00Z",
          lastUpdatedAt: "2026-07-28T00:00:01Z",
          ttlMs: null,
          result: { content: "done" },
        });
      }
      if (seen.method === "tasks/update" || seen.method === "tasks/cancel") {
        return rpc(seen.body.id, {});
      }
      if (seen.method === "skills/list") {
        return rpc(seen.body.id, {
          skills: [
            {
              uri: "skill://a",
              frontmatter: { name: "a" },
              resources: "dynamic",
            },
          ],
        });
      }
      if (seen.method === "skills/get") {
        return rpc(seen.body.id, {
          skill: {
            uri: "skill://a",
            frontmatter: { name: "a" },
            resources: [],
          },
        });
      }
      if (seen.method === "resources/directory/read") {
        return rpc(seen.body.id, {
          resources: [{ uri: "skill://a/SKILL.md", name: "skill" }],
        });
      }
      return rpcError(seen.body.id, McpErrorCode.MethodNotFound, seen.method);
    });
    try {
      await expect(
        mcpGetTask(srv.url, "t1", { session: modern }),
      ).rejects.toThrow(/not enabled/);
      await expect(mcpListSkills(srv.url, { session: modern })).rejects.toThrow(
        /not enabled/,
      );
      const plain = await mcpCallTool(srv.url, "echo", {}, { session: modern });
      expect(plain).toMatchObject({
        resultType: "complete",
        _meta: { ui: { resourceUri: "ui://app" } },
      });
      expect(meta(srv.seen.at(-1) as Seen)[META_CLIENT_CAPABILITIES]).toEqual(
        {},
      );

      const task = await mcpCallTool(
        srv.url,
        "echo",
        {},
        {
          session: modern,
          extensions: [MCP_EXT_TASKS],
        },
      );
      expect(task).toMatchObject({
        resultType: "task",
        taskId: "t1",
        status: "working",
      });
      const detailed = await mcpGetTask(srv.url, "t1", {
        extensions: [MCP_EXT_TASKS],
      });
      expect(detailed).toMatchObject({
        resultType: "complete",
        status: "completed",
      });
      await mcpUpdateTask(
        srv.url,
        "t1",
        { a: { text: "ok" } },
        { extensions: [MCP_EXT_TASKS] },
      );
      await mcpCancelTask(srv.url, "t1", { extensions: [MCP_EXT_TASKS] });

      const ui = await mcpCallTool(
        srv.url,
        "echo",
        {},
        {
          session: modern,
          extensions: [MCP_EXT_UI],
        },
      );
      expect(ui.resultType).toBe("complete");
      const advertised = meta(srv.seen.at(-1) as Seen)[
        META_CLIENT_CAPABILITIES
      ] as {
        extensions: Record<string, { mimeTypes?: string[] }>;
      };
      expect(advertised.extensions[MCP_EXT_UI]?.mimeTypes).toEqual([
        "text/html;profile=mcp-app",
      ]);

      const skills = await mcpListSkills(srv.url, {
        extensions: [MCP_EXT_SKILLS],
      });
      expect(skills[0]?.resources).toBe("dynamic");
      const skill = await mcpGetSkill(srv.url, "skill://a", {
        extensions: [MCP_EXT_SKILLS],
      });
      expect(skill.skill.uri).toBe("skill://a");
      await expect(
        mcpReadResourceDirectory(srv.url, "skill://a", {
          extensions: [MCP_EXT_SKILLS],
        }),
      ).rejects.toThrow(/directoryRead/);
      const withDirectory: McpSession = {
        protocolVersion: MCP_PROTOCOL_VERSION,
        extensions: [MCP_EXT_SKILLS],
        capabilities: {
          extensions: { [MCP_EXT_SKILLS]: { directoryRead: true } },
        },
      };
      const directory = await mcpReadResourceDirectory(srv.url, "skill://a", {
        session: withDirectory,
      });
      expect(directory.map((resource) => resource.uri)).toEqual([
        "skill://a/SKILL.md",
      ]);
    } finally {
      srv.stop();
    }
  });

  test("a task result is rejected when the tasks extension is off", async () => {
    const srv = jsonServer((seen) =>
      rpc(seen.body.id, {
        resultType: "task",
        taskId: "t1",
        status: "working",
        createdAt: "2026-07-28T00:00:00Z",
        lastUpdatedAt: "2026-07-28T00:00:00Z",
        ttlMs: null,
      }),
    );
    try {
      await expect(
        mcpCallTool(srv.url, "echo", {}, { session: modern }),
      ).rejects.toThrow(/not enabled/);
    } finally {
      srv.stop();
    }
  });
});
