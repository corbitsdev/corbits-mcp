import { expect, test } from "bun:test";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createInterchangeProviders } from "../interchange/server.js";
import { createMcpServer, createToolProviders } from "../server.js";
import type {
  McpLegacyRevision,
  McpProviders,
  McpServer,
} from "./contracts.js";
import type { McpAuthPolicy } from "../auth/contracts.js";
import { rpc, result } from "./fixtures.js";

const serverInfo = { name: "legacy-fixture", version: "1" };
const revisions: McpLegacyRevision[] = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
];
const tools = () =>
  createToolProviders(
    [
      {
        definition: {
          name: "echo",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
            additionalProperties: false,
          },
        },
        resource: "tool:echo",
        action: "call",
        execute: (args, context) => {
          context.reportProgress(1, 1);
          return { content: [{ type: "text", text: args.text }] };
        },
      },
    ],
    "public",
  );
function post(
  body: unknown,
  session?: string,
  version?: string,
  extra: Record<string, string> = {},
) {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(session ? { "Mcp-Session-Id": session } : {}),
      ...(version ? { "MCP-Protocol-Version": version } : {}),
      ...extra,
    },
    body: JSON.stringify(body),
  });
}
const message = (
  id: number,
  method = "tools/list",
  params: Record<string, unknown> = {},
) => ({ jsonrpc: "2.0", id, method, params });
async function initialize(
  server: McpServer,
  version = "2025-11-25",
  headers: Record<string, string> = {},
) {
  const response = await server.fetch(
    post(
      message(0, "initialize", {
        protocolVersion: version,
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      }),
      undefined,
      undefined,
      headers,
    ),
  );
  expect(response.status).toBe(200);
  const session = response.headers.get("Mcp-Session-Id")!;
  expect(session).toMatch(/^[\x21-\x7e]+$/);
  return session;
}
const initialized = (
  session: string,
  version = "2025-11-25",
  headers: Record<string, string> = {},
) =>
  post(
    { jsonrpc: "2.0", method: "notifications/initialized" },
    session,
    version,
    headers,
  );
async function events(response: Response): Promise<Record<string, unknown>[]> {
  if (response.headers.get("content-type")?.includes("application/json"))
    return [(await response.json()) as Record<string, unknown>];
  return (await response.text())
    .trim()
    .split("\n\n")
    .map((event) => JSON.parse(event.slice(6)) as Record<string, unknown>);
}

for (const version of revisions)
  test(`SDK client interoperates with gated ${version} over real HTTP`, async () => {
    const providers: McpProviders = {
      ...tools(),
      "prompts/list": {
        resource: "prompts",
        action: "read",
        handle: () => ({ prompts: [{ name: "hello" }] }),
      },
      "prompts/get": {
        resource: "prompts",
        action: "read",
        handle: () => ({
          messages: [
            { role: "user", content: { type: "text", text: "Hello" } },
          ],
        }),
      },
      "resources/list": {
        resource: "resources",
        action: "read",
        handle: () => ({ resources: [{ name: "file", uri: "test:///file" }] }),
      },
      "resources/templates/list": {
        resource: "resources",
        action: "read",
        handle: () => ({ resourceTemplates: [] }),
      },
      "resources/read": {
        resource: "resources",
        action: "read",
        handle: () => ({ contents: [{ uri: "test:///file", text: "data" }] }),
      },
      "completion/complete": {
        resource: "completion",
        action: "read",
        handle: () => ({ completion: { values: ["hello"] } }),
      },
    };
    const endpoint = createMcpServer({
      serverInfo,
      auth: "public",
      legacy: { versions: [version] },
      providers,
    });
    const listener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: endpoint.fetch,
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${listener.port}/mcp`),
    );
    const client = new Client({ name: "official-sdk", version: "1" });
    try {
      // SDK 1.30.1 exposes sessionId: string|undefined, incompatible with its own
      // optional Transport property under exactOptionalPropertyTypes. Forward its
      // real transport without casting away that discrepancy.
      const bridge: Transport = {
        async start() {
          transport.onmessage = (message) => bridge.onmessage?.(message);
          transport.onerror = (error) => bridge.onerror?.(error);
          transport.onclose = () => bridge.onclose?.();
          await transport.start();
        },
        send: (message, options) => transport.send(message, options),
        close: () => transport.close(),
        setProtocolVersion: (version) => transport.setProtocolVersion(version),
      };
      await client.connect(bridge);
      expect(transport.protocolVersion).toBe(version);
      expect(client.getServerCapabilities()).not.toHaveProperty("extensions");
      expect((await client.listTools()).tools[0]?.name).toBe("echo");
      const progress: number[] = [];
      expect(
        await client.callTool(
          { name: "echo", arguments: { text: "SDK call" } },
          undefined,
          {
            onprogress: (value) => {
              progress.push(value.progress);
            },
          },
        ),
      ).toMatchObject({ content: [{ text: "SDK call" }] });
      expect(progress).toEqual([1]);
      expect((await client.listPrompts()).prompts[0]?.name).toBe("hello");
      expect(await client.getPrompt({ name: "hello" })).toHaveProperty(
        "messages",
      );
      expect((await client.listResources()).resources[0]?.uri).toBe(
        "test:///file",
      );
      expect(await client.readResource({ uri: "test:///file" })).toMatchObject({
        contents: [{ text: "data" }],
      });
      expect(await client.listResourceTemplates()).toMatchObject({
        resourceTemplates: [],
      });
      expect(
        await client.complete({
          ref: { type: "ref/prompt", name: "hello" },
          argument: { name: "arg", value: "he" },
        }),
      ).toMatchObject({ completion: { values: ["hello"] } });
      const session = transport.sessionId!;
      await transport.terminateSession();
      expect(
        (await endpoint.fetch(post(message(100), session, version))).status,
      ).toBe(404);
    } finally {
      await client.close();
      await endpoint.close();
      await listener.stop(true);
    }
  });

test("legacy mode is explicit and modern requests remain stateless", async () => {
  const modern = createMcpServer({
    serverInfo,
    auth: "public",
    providers: tools(),
  });
  const dual = createMcpServer({
    serverInfo,
    auth: "public",
    providers: tools(),
    legacy: { versions: ["2025-06-18"] },
  });
  try {
    expect(
      (
        await modern.fetch(
          post(
            message(0, "initialize", {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "test", version: "1" },
            }),
          ),
        )
      ).status,
    ).toBe(400);
    const response = await dual.fetch(rpc("server/discover"));
    expect(response.headers.has("Mcp-Session-Id")).toBe(false);
    expect(await result(response)).toHaveProperty("result.supportedVersions", [
      "2026-07-28",
      "2025-06-18",
    ]);
    expect(
      await result(
        await dual.fetch(
          rpc(
            "tools/call",
            { name: "echo", arguments: { text: "modern" } },
            { "Mcp-Session-Id": "ignored-on-modern" },
          ),
        ),
      ),
    ).toMatchObject({ result: { resultType: "complete" } });
  } finally {
    await modern.close();
    await dual.close();
  }
});

test("legacy handshake, headers, missing/expired sessions, capacity and GET405", async () => {
  const endpoint = createMcpServer({
    serverInfo,
    auth: "public",
    providers: tools(),
    legacy: { maxSessions: 1, sessionTtlMs: 100 },
  });
  try {
    const session = await initialize(endpoint);
    expect(
      await result(
        await endpoint.fetch(post(message(1), session, "2025-11-25")),
      ),
    ).toHaveProperty("error");
    expect((await endpoint.fetch(initialized(session))).status).toBe(202);
    expect(
      (await endpoint.fetch(post(message(2), undefined, "2025-11-25"))).status,
    ).toBe(400);
    expect(
      (await endpoint.fetch(post(message(2), session, "2025-06-18"))).status,
    ).toBe(400);
    expect((await endpoint.fetch(post(message(2), session))).status).toBe(400);
    expect(
      (
        await endpoint.fetch(
          new Request("http://localhost/mcp", {
            headers: {
              "Mcp-Session-Id": session,
              "MCP-Protocol-Version": "2025-11-25",
              Accept: "text/event-stream",
            },
          }),
        )
      ).status,
    ).toBe(405);
    expect(
      (
        await endpoint.fetch(
          post(
            message(0, "initialize", {
              protocolVersion: "2025-11-25",
              capabilities: {},
              clientInfo: { name: "test", version: "1" },
            }),
          ),
        )
      ).status,
    ).toBe(503);
    await Bun.sleep(120);
    expect(
      (await endpoint.fetch(post(message(3), session, "2025-11-25"))).status,
    ).toBe(404);
    await initialize(endpoint);
  } finally {
    await endpoint.close();
  }
});

test("sessions are bound to authenticated tenant/principal/context and every call rechecks authorization", async () => {
  let calls = 0;
  let granted = true;
  const auth: McpAuthPolicy = {
    authenticate: (request) =>
      request.headers.get("authorization") === "missing"
        ? null
        : {
            tenantId: request.headers.get("tenant") ?? "tenant",
            principalId: request.headers.get("principal") ?? "principal",
            authorizationContextId:
              request.headers.get("partition") ?? "grants",
            scopes: [],
          },
    authorize: () => granted,
  };
  const endpoint = createMcpServer({
    serverInfo,
    auth,
    legacy: {},
    providers: {
      "tools/list": {
        resource: "tools",
        action: "read",
        handle: () => {
          calls++;
          return { tools: [] };
        },
      },
    },
  });
  try {
    const session = await initialize(endpoint);
    await endpoint.fetch(initialized(session));
    for (const headers of [
      { tenant: "other" },
      { principal: "other" },
      { partition: "other" },
    ])
      expect(
        (await endpoint.fetch(post(message(1), session, "2025-11-25", headers)))
          .status,
      ).toBe(404);
    expect(
      (
        await endpoint.fetch(
          post(message(1), session, "2025-11-25", { authorization: "missing" }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await endpoint.fetch(
          post(message(1), session, "2025-11-25", {
            Origin: "https://evil.example",
          }),
        )
      ).status,
    ).toBe(403);
    granted = false;
    expect(
      await result(
        await endpoint.fetch(post(message(1), session, "2025-11-25")),
      ),
    ).toHaveProperty("error");
    expect(calls).toBe(0);
  } finally {
    await endpoint.close();
  }
});

test("March batches mix requests and notifications, later revisions and initialize batches are rejected", async () => {
  for (const version of revisions) {
    const endpoint = createMcpServer({
      serverInfo,
      auth: "public",
      legacy: { versions: [version] },
      providers: tools(),
    });
    try {
      const session = await initialize(endpoint, version);
      await endpoint.fetch(initialized(session, version));
      const response = await endpoint.fetch(
        post(
          [
            message(1),
            {
              jsonrpc: "2.0",
              method: "notifications/cancelled",
              params: { requestId: "unknown" },
            },
            message(2, "tools/call", {
              name: "echo",
              arguments: { text: "batch" },
            }),
          ],
          session,
          version,
        ),
      );
      if (version === "2025-03-26") {
        const replies = await events(response);
        expect(replies.map((reply) => reply.id).sort()).toEqual([1, 2]);
        expect(replies.every((reply) => reply.result !== undefined)).toBe(true);
        expect(
          (
            await endpoint.fetch(
              post(
                [
                  {
                    jsonrpc: "2.0",
                    method: "notifications/cancelled",
                    params: { requestId: "unknown" },
                  },
                ],
                session,
                version,
              ),
            )
          ).status,
        ).toBe(202);
      } else expect(response.status).toBe(400);
      expect(
        (
          await endpoint.fetch(
            post(
              [
                message(8, "initialize", {
                  protocolVersion: version,
                  capabilities: {},
                  clientInfo: { name: "test", version: "1" },
                }),
              ],
              session,
              version,
            ),
          )
        ).status,
      ).toBe(400);
    } finally {
      await endpoint.close();
    }
  }
});

test("legacy schema boundaries reject invalid arguments, modern methods and polymorphic results", async () => {
  let calls = 0;
  const endpoint = createMcpServer({
    serverInfo,
    auth: "public",
    legacy: {},
    providers: {
      ...createToolProviders(
        [
          {
            definition: {
              name: "strict",
              inputSchema: {
                type: "object",
                required: ["value"],
                properties: { value: { type: "number" } },
              },
            },
            resource: "tool:strict",
            action: "call",
            execute: (args) => {
              calls++;
              return args.value === 2
                ? {
                    resultType: "task",
                    taskId: "not-on-legacy",
                    status: "working",
                    createdAt: "2026-01-01T00:00:00Z",
                    lastUpdatedAt: "2026-01-01T00:00:00Z",
                    ttlMs: 1000,
                  }
                : {
                    resultType: "input_required",
                    requestState: "never-on-legacy",
                  };
            },
          },
        ],
        "public",
      ),
    },
  });
  try {
    const session = await initialize(endpoint);
    await endpoint.fetch(initialized(session));
    for (const [id, method, params] of [
      [1, "tools/call", { name: "strict", arguments: { value: "wrong" } }],
      [
        2,
        "tools/call",
        { name: "strict", arguments: { value: 1 }, inputResponses: {} },
      ],
      [3, "tasks/get", { taskId: "x" }],
      [4, "subscriptions/listen", { notifications: {} }],
    ] as const)
      expect(
        await result(
          await endpoint.fetch(
            post(message(id, method, params), session, "2025-11-25"),
          ),
        ),
      ).toHaveProperty("error");
    expect(calls).toBe(0);
    expect(
      await result(
        await endpoint.fetch(
          post(
            message(5, "tools/call", {
              name: "strict",
              arguments: { value: 1 },
            }),
            session,
            "2025-11-25",
          ),
        ),
      ),
    ).toHaveProperty("error");
    expect(calls).toBe(1);
    expect(
      await result(
        await endpoint.fetch(
          post(
            message(6, "tools/call", {
              name: "strict",
              arguments: { value: 2 },
            }),
            session,
            "2025-11-25",
          ),
        ),
      ),
    ).toHaveProperty("error");
  } finally {
    await endpoint.close();
  }
});

test("legacy disconnect is not cancellation; explicit cancellation is session-scoped", async () => {
  const signals: AbortSignal[] = [];
  const endpoint = createMcpServer({
    serverInfo,
    auth: "public",
    legacy: {},
    providers: {
      "tools/call": {
        resource: "work",
        action: "call",
        async handle(_params, context) {
          signals.push(context.signal);
          context.reportProgress(1);
          await new Promise<void>((resolve) =>
            context.signal.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
          return { content: [] };
        },
      },
    },
  });
  try {
    const a = await initialize(endpoint),
      b = await initialize(endpoint);
    await endpoint.fetch(initialized(a));
    await endpoint.fetch(initialized(b));
    const call = message(1, "tools/call", {
      name: "work",
      _meta: { progressToken: "progress" },
    });
    const ra = (
      await endpoint.fetch(post(call, a, "2025-11-25"))
    ).body!.getReader();
    const rb = (
      await endpoint.fetch(post(call, b, "2025-11-25"))
    ).body!.getReader();
    await ra.read();
    await rb.read();
    await ra.cancel();
    expect(signals[0]?.aborted).toBe(false);
    expect(
      (
        await endpoint.fetch(
          post(
            {
              jsonrpc: "2.0",
              method: "notifications/cancelled",
              params: { requestId: 1 },
            },
            a,
            "2025-11-25",
          ),
        )
      ).status,
    ).toBe(202);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    await endpoint.fetch(
      new Request("http://localhost/mcp", {
        method: "DELETE",
        headers: { "Mcp-Session-Id": b, "MCP-Protocol-Version": "2025-11-25" },
      }),
    );
    expect(signals[1]?.aborted).toBe(true);
    await rb.cancel();
  } finally {
    await endpoint.close();
  }
});

test("March omits protocol header legally; IDs cannot be reused and malformed batch members get individual errors", async () => {
  const endpoint = createMcpServer({
    serverInfo,
    auth: "public",
    legacy: { versions: ["2025-03-26"] },
    providers: tools(),
  });
  try {
    const session = await initialize(endpoint, "2025-03-26");
    expect(
      (
        await endpoint.fetch(
          post(
            { jsonrpc: "2.0", method: "notifications/initialized" },
            session,
          ),
        )
      ).status,
    ).toBe(202);
    const response = await endpoint.fetch(
      post([message(1), 42, message(2, "ping")], session),
    );
    const replies = await events(response);
    expect(replies).toHaveLength(3);
    expect(replies.find((reply) => reply.id === null)).toHaveProperty(
      "error.code",
      -32600,
    );
    expect(replies.find((reply) => reply.id === 1)).toHaveProperty(
      "result.tools",
    );
    expect(replies.find((reply) => reply.id === 2)).toHaveProperty("result");
    expect(
      await result(await endpoint.fetch(post(message(1), session))),
    ).toHaveProperty("error.code", -32600);
    expect((await endpoint.fetch(post([], session))).status).toBe(400);
  } finally {
    await endpoint.close();
  }
});

test("cancellation during asynchronous authorization prevents provider dispatch", async () => {
  let release!: () => void;
  let checking!: () => void;
  const started = new Promise<void>((resolve) => {
    checking = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const auth: McpAuthPolicy = {
    authenticate: () => ({
      tenantId: "tenant",
      principalId: "principal",
      authorizationContextId: "grants",
      scopes: [],
    }),
    authorize: async (_identity, operation) => {
      if (operation.action === "call") {
        checking();
        await wait;
      }
      return true;
    },
  };
  const endpoint = createMcpServer({
    serverInfo,
    auth,
    legacy: {},
    providers: {
      "tools/call": {
        resource: "work",
        action: "call",
        handle: () => {
          calls++;
          return { content: [] };
        },
      },
    },
  });
  try {
    const session = await initialize(endpoint);
    await endpoint.fetch(initialized(session));
    const response = await endpoint.fetch(
      post(message(1, "tools/call", { name: "work" }), session, "2025-11-25"),
    );
    await started;
    await endpoint.fetch(
      post(
        {
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: 1 },
        },
        session,
        "2025-11-25",
      ),
    );
    const settled = await Promise.race([
      result(response).then(() => "cancelled"),
      Bun.sleep(50).then(() => "still-waiting"),
    ]);
    release();
    expect(settled).toBe("cancelled");
    expect(calls).toBe(0);
  } finally {
    release();
    await endpoint.close();
  }
});

test("legacy exports retain the Interchange approval gate", async () => {
  let calls = 0;
  const identity = {
    tenantId: "tenant",
    principalId: "principal",
    authorizationContextId: "grants",
    scopes: [],
  };
  const auth: McpAuthPolicy = {
    authenticate: () => identity,
    authorize: () => true,
  };
  const definition = {
    name: "selected",
    description: "Approval required",
    inputSchema: { type: "object" },
  };
  const endpoint = createMcpServer({
    serverInfo,
    auth,
    legacy: {},
    providers: createInterchangeProviders({
      auth,
      exposures: [
        {
          kind: "tool",
          definition,
          tenantId: "tenant",
          resource: "tool:selected",
          action: "call",
          approve: async () => false,
          toolName: "selected",
          bundle: {
            definitions: [definition],
            run: async (call) => {
              calls++;
              return { callId: call.id, content: "must not execute" };
            },
          },
        },
      ],
    }),
  });
  try {
    const session = await initialize(endpoint);
    await endpoint.fetch(initialized(session));
    expect(
      await result(
        await endpoint.fetch(
          post(
            message(1, "tools/call", { name: "selected", arguments: {} }),
            session,
            "2025-11-25",
          ),
        ),
      ),
    ).toHaveProperty("error");
    expect(calls).toBe(0);
  } finally {
    await endpoint.close();
  }
});

test("legacy malformed and unsolicited response envelopes are HTTP errors", async () => {
  const endpoint = createMcpServer({
    serverInfo,
    auth: "public",
    legacy: {},
    providers: tools(),
  });
  try {
    const session = await initialize(endpoint);
    await endpoint.fetch(initialized(session));
    for (const body of [
      42,
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", id: null, method: "tools/list" },
      { jsonrpc: "2.0", method: "notifications/unsupported" },
    ]) {
      expect(
        (await endpoint.fetch(post(body, session, "2025-11-25"))).status,
      ).toBe(400);
    }
  } finally {
    await endpoint.close();
  }
});

test("March projects newer tool output into supported content without dropping structured data", async () => {
  const endpoint = createMcpServer({
    serverInfo,
    auth: "public",
    legacy: { versions: ["2025-03-26"] },
    providers: createToolProviders(
      [
        {
          definition: {
            name: "newer",
            inputSchema: { type: "object" },
            outputSchema: {
              type: "object",
              properties: { answer: { type: "number" } },
              required: ["answer"],
            },
          },
          resource: "tool:newer",
          action: "call",
          execute: () => ({
            content: [
              {
                type: "resource_link",
                name: "reference",
                uri: "test:///reference",
              },
            ],
            structuredContent: { answer: 42 },
          }),
        },
      ],
      "public",
    ),
  });
  try {
    const session = await initialize(endpoint, "2025-03-26");
    await endpoint.fetch(initialized(session, "2025-03-26"));
    const catalog = await result(
      await endpoint.fetch(post(message(1), session)),
    );
    expect(catalog).not.toHaveProperty("result.tools.0.outputSchema");
    const answer = await result(
      await endpoint.fetch(
        post(
          message(2, "tools/call", { name: "newer", arguments: {} }),
          session,
        ),
      ),
    );
    expect(answer).not.toHaveProperty("result.resultType");
    expect(answer).not.toHaveProperty("result.structuredContent");
    expect(answer).toMatchObject({
      result: {
        content: [
          { type: "text", text: "reference: test:///reference" },
          { type: "text", text: '{"answer":42}' },
        ],
      },
    });
  } finally {
    await endpoint.close();
  }
});
