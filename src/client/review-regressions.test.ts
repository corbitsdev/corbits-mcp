import { expect, spyOn, test } from "bun:test";
import {
  createMcpRequestTransport,
  DEFAULT_TIMEOUT_MS,
  mcpCallTool,
  mcpConnect,
  mcpListen,
  MCP_EXT_TASKS,
  MCP_PROTOCOL_VERSION,
  McpError,
  type McpClientOptions,
} from "../client.js";
import {
  validateInputRequests,
  validateNotification,
  validateRequest,
  validateResult,
} from "../protocol/schemas.js";
import type { FetchLike } from "../protocol/types.js";

const url = "https://example.test/mcp";
const subscriptionKey = "io.modelcontextprotocol/subscriptionId";
type Request = {
  id: number;
  method: string;
  params: Record<string, unknown> & { _meta?: Record<string, unknown> };
};
const mock =
  (reply: (request: Request) => Response | Promise<Response>): FetchLike =>
  async (_url, init) =>
    reply(JSON.parse(String(init?.body)) as Request);
const rpc = (id: number, result: unknown) => ({ jsonrpc: "2.0", id, result });
const sse = (messages: unknown[]) =>
  new Response(
    messages.map((message) => `data: ${JSON.stringify(message)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
const form = (property: unknown = { type: "string" }) => ({
  method: "elicitation/create",
  params: {
    message: "Choose",
    requestedSchema: { type: "object", properties: { choice: property } },
  },
});
const pending = (request: unknown) => ({
  resultType: "input_required",
  inputRequests: { choice: request },
});
const task = {
  taskId: "t",
  status: "completed",
  createdAt: "2026-01-01T00:00:00Z",
  lastUpdatedAt: "2026-01-01T00:00:00Z",
  ttlMs: null,
};

test("F2 facade distinguishes absent from invalid result discriminators", async () => {
  for (const resultType of [null, 3, "unknown"]) {
    await expect(
      mcpCallTool(
        url,
        "t",
        {},
        {
          fetch: mock((r) =>
            Response.json(rpc(r.id, { resultType, content: [] })),
          ),
        },
      ),
    ).rejects.toBeInstanceOf(McpError);
  }
  await expect(
    mcpCallTool(
      url,
      "t",
      {},
      { fetch: mock((r) => Response.json(rpc(r.id, { content: [] }))) },
    ),
  ).resolves.toHaveProperty("content", []);
});

test("F3 completed tasks contain only final complete tool results, including notifications", () => {
  const context = { extensions: [MCP_EXT_TASKS] };
  for (const result of [
    { resultType: "input_required", requestState: "pending" },
    { ...task, resultType: "task" },
  ]) {
    expect(() =>
      validateResult("tasks/get", { ...task, result }, context),
    ).toThrow();
    expect(() =>
      validateNotification("notifications/tasks", { ...task, result }, context),
    ).toThrow();
  }
  expect(() =>
    validateResult("tasks/get", { ...task, result: { content: [] } }, context),
  ).not.toThrow();
});

test("F4 response validation uses effective advertised capabilities including inherited and empty", async () => {
  const session = await mcpConnect(url, {
    elicitation: { form: true },
    fetch: mock((r) =>
      Response.json(
        rpc(r.id, {
          supportedVersions: [MCP_PROTOCOL_VERSION],
          capabilities: { tools: {} },
        }),
      ),
    ),
  });
  const urlRequest = {
    method: "elicitation/create",
    params: {
      mode: "url",
      message: "Login",
      url: "https://example.test/login",
    },
  };
  for (const opts of [{ session }, { session, clientCapabilities: {} }, {}]) {
    const request =
      "session" in opts && !("clientCapabilities" in opts)
        ? urlRequest
        : form();
    await expect(
      mcpCallTool(
        url,
        "t",
        {},
        {
          ...opts,
          fetch: mock((r) => Response.json(rpc(r.id, pending(request)))),
        },
      ),
    ).rejects.toBeInstanceOf(McpError);
  }
  await expect(
    mcpCallTool(
      url,
      "t",
      {},
      {
        session,
        fetch: mock((r) => Response.json(rpc(r.id, pending(form())))),
      },
    ),
  ).resolves.toHaveProperty("resultType", "input_required");
});

test("F5 modern cancellation closes streams without legacy notification; legacy still notifies", async () => {
  for (const mode of ["modern", "legacy", "subscription"]) {
    const controller = new AbortController();
    const methods: string[] = [];
    let closed = false;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fetch = mock((r) => {
      methods.push(r.method);
      if (r.method === "notifications/cancelled")
        return new Response(null, { status: 202 });
      return new Response(
        new ReadableStream({
          start() {
            started();
          },
          cancel() {
            closed = true;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const opts: McpClientOptions = {
      fetch,
      signal: controller.signal,
      ...(mode === "legacy"
        ? { session: { protocolVersion: "2025-11-25" } }
        : {}),
    };
    const result = (
      mode === "subscription"
        ? mcpListen(url, {}, () => {}, opts)
        : mcpCallTool(url, "t", {}, opts)
    ).catch((e: unknown) => e);
    await ready;
    await Bun.sleep(0);
    controller.abort();
    expect(await result).toHaveProperty("cancelled", true);
    expect(closed).toBe(true);
    expect(methods.includes("notifications/cancelled")).toBe(mode === "legacy");
  }
});

test("F6 request extension metadata and pending result metadata survive client boundaries", async () => {
  const metadata = { "example.org/trace": "trace" };
  const transport = createMcpRequestTransport(url, {
    fetch: mock((r) => {
      expect(r.params._meta).toMatchObject(metadata);
      return Response.json(rpc(r.id, { content: [] }));
    }),
  });
  await transport.request("tools/call", { name: "t", _meta: metadata });
  const result = await mcpCallTool(
    url,
    "t",
    {},
    {
      fetch: mock((r) =>
        Response.json(
          rpc(r.id, {
            resultType: "input_required",
            requestState: "pending",
            _meta: metadata,
          }),
        ),
      ),
    },
  );
  expect(result).toHaveProperty("_meta", metadata);
});

test("F7 subscription errors validate envelope and correlation before peer classification", async () => {
  for (const shape of ["wrong-id", "mixed", "peer"]) {
    const error = await mcpListen(url, {}, () => {}, {
      fetch: mock((r) =>
        Response.json({
          jsonrpc: "2.0",
          id: shape === "wrong-id" ? r.id + 1 : r.id,
          error: { code: -32603, message: "peer failure" },
          ...(shape === "mixed" ? { result: {} } : {}),
        }),
      ),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpError);
    expect(error).toHaveProperty("source", shape === "peer" ? "peer" : "local");
  }
});

test("F7 successful subscriptions require acknowledgement first", async () => {
  for (const acknowledged of [false, true]) {
    const result = mcpListen(url, { toolsListChanged: true }, () => {}, {
      fetch: mock((r) => {
        const _meta = { [subscriptionKey]: r.id };
        return sse([
          ...(acknowledged
            ? [
                {
                  jsonrpc: "2.0",
                  method: "notifications/subscriptions/acknowledged",
                  params: { notifications: { toolsListChanged: true }, _meta },
                },
              ]
            : []),
          rpc(r.id, { _meta }),
        ]);
      }),
    });
    if (acknowledged) await expect(result).resolves.toBeUndefined();
    else await expect(result).rejects.toThrow("acknowledgement");
  }
});

test("F8 recognized version errors cannot override auth/rate-limit/server HTTP status", async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    const methods: string[] = [];
    const error = await mcpConnect(url, {
      fetch: mock((r) => {
        methods.push(r.method);
        return Response.json(
          {
            jsonrpc: "2.0",
            id: r.id,
            error: {
              code: -32022,
              message: "Unsupported protocol version",
              data: { supported: ["2025-11-25"] },
            },
          },
          { status },
        );
      }),
    }).catch((e: unknown) => e);
    expect(error).toHaveProperty("status", status);
    expect(methods).toEqual(["server/discover"]);
  }
});

test("F9 elicitation accepts only primitive and string-enum forms", () => {
  for (const property of [
    { type: "string" },
    { type: "number" },
    { type: "integer" },
    { type: "boolean" },
    { type: "string", enum: ["a"] },
    { type: "string", oneOf: [{ const: "a", title: "A" }] },
    { type: "array", items: { type: "string", enum: ["a", "b"] } },
    { type: "array", items: { anyOf: [{ const: "a", title: "A" }] } },
  ]) {
    expect(() =>
      validateInputRequests({ input: form(property) }),
    ).not.toThrow();
  }
  for (const property of [
    {},
    { type: "null" },
    { type: "object" },
    {
      type: "array",
      items: { type: "object", properties: { nested: { type: "string" } } },
    },
    { type: "array", items: { type: "array" } },
    { type: "array", items: { type: "string" } },
    { type: "string", enum: [3] },
  ]) {
    expect(() => validateInputRequests({ input: form(property) })).toThrow();
  }
});

test("F10 standalone requests install 60s default; subscriptions remain explicitly long-lived", async () => {
  const timeout = spyOn(AbortSignal, "timeout");
  try {
    await mcpCallTool(
      url,
      "t",
      {},
      { fetch: mock((r) => Response.json(rpc(r.id, { content: [] }))) },
    );
    expect(timeout).toHaveBeenCalledWith(DEFAULT_TIMEOUT_MS);
    timeout.mockClear();
    await mcpListen(url, {}, () => {}, {
      fetch: mock((r) =>
        Response.json({
          jsonrpc: "2.0",
          id: r.id,
          error: { code: -32603, message: "stop" },
        }),
      ),
    }).catch(() => {});
    expect(timeout).not.toHaveBeenCalled();
  } finally {
    timeout.mockRestore();
  }
});

test("F11 progress token shape is canonical for requests and notifications; legacy advertises progress", async () => {
  for (const token of [0.5, NaN, Infinity, {}, null]) {
    expect(() =>
      validateRequest(
        "tools/call",
        { name: "t", _meta: { progressToken: token } },
        { era: "legacy" },
      ),
    ).toThrow();
    expect(() =>
      validateNotification("notifications/progress", {
        progressToken: token,
        progress: 1,
      }),
    ).toThrow();
  }
  for (const token of [-1, 0, "token"])
    expect(() =>
      validateNotification("notifications/progress", {
        progressToken: token,
        progress: 0.5,
      }),
    ).not.toThrow();
  await mcpCallTool(
    url,
    "t",
    {},
    {
      session: { protocolVersion: "2025-11-25" },
      onProgress() {},
      fetch: mock((r) => {
        expect(r.params._meta?.progressToken).toBe(r.id);
        return Response.json(rpc(r.id, { content: [] }));
      }),
    },
  );
});

test("F11 active progress tokens cannot collide and are released on completion", async () => {
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const opts = {
    progressToken: "unique",
    fetch: mock(async (r) => {
      calls++;
      started();
      await gate;
      return Response.json(rpc(r.id, { content: [] }));
    }),
  };
  const first = mcpCallTool(url, "t", {}, opts);
  await ready;
  const second = mcpCallTool(url, "t", {}, opts).catch((e: unknown) => e);
  await Bun.sleep(0);
  release();
  await first;
  expect(await second).toBeInstanceOf(McpError);
  expect(calls).toBe(1);
  await mcpCallTool(url, "t", {}, opts);
  expect(calls).toBe(2);
});

test("F11 progress must strictly increase, with floating point progress allowed", async () => {
  for (const values of [
    [0.5, 1.5],
    [1, 1],
    [2, 1],
  ]) {
    const seen: number[] = [];
    const result = mcpCallTool(
      url,
      "t",
      {},
      {
        progressToken: "p",
        onProgress(p) {
          seen.push(p.progress);
        },
        fetch: mock((r) =>
          sse([
            ...values.map((progress) => ({
              jsonrpc: "2.0",
              method: "notifications/progress",
              params: { progressToken: "p", progress },
            })),
            rpc(r.id, { content: [] }),
          ]),
        ),
      },
    );
    if (values[0]! < values[1]!) {
      await result;
      expect(seen).toEqual(values);
    } else await expect(result).rejects.toThrow("progress");
  }
});

test("F11 subscriptions reserve their advertised progress token until cancellation", async () => {
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const stream = mcpListen(url, {}, () => {}, {
    signal: controller.signal,
    progressToken: "subscription-progress",
    fetch: mock(
      () =>
        new Response(
          new ReadableStream({
            start() {
              started();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    ),
  }).catch((error: unknown) => error);
  await ready;
  const opts = {
    progressToken: "subscription-progress",
    fetch: mock((r) => Response.json(rpc(r.id, { content: [] }))),
  };
  const collision = await mcpCallTool(url, "t", {}, opts).catch(
    (error: unknown) => error,
  );
  controller.abort();
  await stream;
  expect(collision).toBeInstanceOf(McpError);
  await expect(mcpCallTool(url, "t", {}, opts)).resolves.toHaveProperty(
    "content",
    [],
  );
});

test("F4 per-request capabilities override inherited host support, including explicit disabling", async () => {
  const session = {
    protocolVersion: MCP_PROTOCOL_VERSION,
    clientCapabilities: { elicitation: { form: {} } },
  };
  const fetch = mock((r) => Response.json(rpc(r.id, pending(form()))));
  await expect(
    mcpCallTool(url, "t", {}, { session, elicitation: { form: false }, fetch }),
  ).rejects.toThrow("capability");
  await expect(
    mcpCallTool(
      url,
      "t",
      {},
      { session, clientCapabilities: { elicitation: {} }, fetch },
    ),
  ).resolves.toHaveProperty("resultType", "input_required");
});

test("F10 explicit request and subscription timeouts override their defaults", async () => {
  const timeout = spyOn(AbortSignal, "timeout");
  try {
    await mcpCallTool(
      url,
      "t",
      {},
      {
        timeoutMs: 1234,
        fetch: mock((r) => Response.json(rpc(r.id, { content: [] }))),
      },
    );
    expect(timeout).toHaveBeenCalledWith(1234);
    timeout.mockClear();
    await mcpListen(url, {}, () => {}, {
      timeoutMs: 4321,
      fetch: mock((r) =>
        Response.json({
          jsonrpc: "2.0",
          id: r.id,
          error: { code: -32603, message: "stop" },
        }),
      ),
    }).catch(() => {});
    expect(timeout).toHaveBeenCalledWith(4321);
  } finally {
    timeout.mockRestore();
  }
});
