import { expect, test } from "bun:test";
import { createMcpServer, createToolProviders } from "../server.js";
import { McpError } from "../protocol/index.js";
import type { McpProvider, McpProviders } from "./contracts.js";
import { rpc, result } from "./fixtures.js";

const subscriptionId = "io.modelcontextprotocol/subscriptionId";
const serverInfo = { name: "wire-regressions", version: "1" };
const provider = (handle: McpProvider["handle"]): McpProvider => ({
  resource: "fixture",
  action: "read",
  handle,
});
async function frames(response: Response): Promise<Record<string, unknown>[]> {
  if (response.headers.get("content-type")?.includes("application/json"))
    return [(await response.json()) as Record<string, unknown>];
  return (await response.text())
    .trim()
    .split("\n\n")
    .map((event) => JSON.parse(event.slice(6)) as Record<string, unknown>);
}

// MCP 2026 basic: consumer absent=complete compatibility is not an emission waiver.
test("all built-in and authored ordinary results emit complete discriminator", async () => {
  const tools = createToolProviders(
    [
      {
        definition: { name: "echo", inputSchema: { type: "object" } },
        resource: "tool:echo",
        action: "call",
        execute: () => ({ content: [] }),
      },
    ],
    "public",
  );
  const providers: McpProviders = {
    ...tools,
    "prompts/list": provider(() => ({ prompts: [] })),
    "prompts/get": provider(() => ({ messages: [] })),
    "resources/list": provider(() => ({ resources: [] })),
    "resources/templates/list": provider(() => ({ resourceTemplates: [] })),
    "resources/read": provider(() => ({ contents: [] })),
    "completion/complete": provider(() => ({ completion: { values: [] } })),
  };
  const server = createMcpServer({ serverInfo, auth: "public", providers });
  try {
    for (const [method, params] of [
      ["server/discover", {}],
      ["tools/list", {}],
      ["tools/call", { name: "echo" }],
      ["prompts/list", {}],
      ["prompts/get", { name: "prompt" }],
      ["resources/list", {}],
      ["resources/templates/list", {}],
      ["resources/read", { uri: "test:///file" }],
      [
        "completion/complete",
        {
          ref: { type: "ref/prompt", name: "prompt" },
          argument: { name: "arg", value: "" },
        },
      ],
    ] as const)
      expect(
        await result(await server.fetch(rpc(method, params))),
      ).toHaveProperty("result.resultType", "complete");
  } finally {
    await server.close();
  }
});

// Subscriptions: acknowledgement first, accepted subset only, originating ID on every frame.
test("subscription frames carry originating ID and retain provider metadata", async () => {
  const server = createMcpServer({
    serverInfo,
    auth: "public",
    providers: {
      "subscriptions/listen": {
        ...provider((_params, context) => {
          context.notify("notifications/tools/list_changed", {
            _meta: { retained: true, [subscriptionId]: "spoof" },
          });
          return { _meta: { retained: true, [subscriptionId]: "spoof" } };
        }),
        acceptSubscription: () => ({ toolsListChanged: true }),
      },
    },
  });
  try {
    const request = rpc("subscriptions/listen", {
      notifications: { toolsListChanged: true },
    });
    const body = (await request.json()) as Record<string, unknown>;
    const response = await server.fetch(
      new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify({ ...body, id: "stream-7" }),
      }),
    );
    const messages = await frames(response);
    expect(messages).toHaveLength(3);
    expect(messages[0]).toHaveProperty(
      "method",
      "notifications/subscriptions/acknowledged",
    );
    for (const message of messages) {
      const payload = (message.params ?? message.result) as Record<
        string,
        unknown
      >;
      expect(payload._meta).toMatchObject({ [subscriptionId]: "stream-7" });
    }
    expect(messages[1]).toHaveProperty("params._meta.retained", true);
    expect(messages[2]).toHaveProperty("result._meta.retained", true);
    expect(messages[2]).toHaveProperty("result.resultType", "complete");
  } finally {
    await server.close();
  }
});

test("acknowledgement waits for provider acceptance and publishes only accepted filters", async () => {
  const ordering: string[] = [];
  const server = createMcpServer({
    serverInfo,
    auth: "public",
    providers: {
      "subscriptions/listen": {
        ...provider((_params, context) => {
          ordering.push("handle");
          context.notify("notifications/tools/list_changed", {});
          context.notify("notifications/resources/updated", {
            uri: "test:///unsupported",
          });
          return {};
        }),
        async acceptSubscription() {
          await Promise.resolve();
          ordering.push("accepted");
          return { toolsListChanged: true };
        },
      },
    },
  });
  try {
    const messages = await frames(
      await server.fetch(
        rpc("subscriptions/listen", {
          notifications: {
            toolsListChanged: true,
            resourceSubscriptions: ["test:///unsupported"],
          },
        }),
      ),
    );
    expect(ordering).toEqual(["accepted", "handle"]);
    expect(messages[0]).toHaveProperty("params.notifications", {
      toolsListChanged: true,
    });
    expect(
      messages.some(
        (message) => message.method === "notifications/resources/updated",
      ),
    ).toBe(false);
  } finally {
    await server.close();
  }
});

test("rejected or widened subscriptions never receive acknowledgement or execute handler", async () => {
  for (const acceptSubscription of [
    () => {
      throw new McpError("Unsupported subscription", 400, -32602);
    },
    () => ({ resourceSubscriptions: ["test:///not-requested"] }),
  ]) {
    let executed = false;
    const server = createMcpServer({
      serverInfo,
      auth: "public",
      providers: {
        "subscriptions/listen": {
          ...provider(() => {
            executed = true;
            return {};
          }),
          acceptSubscription,
        },
      },
    });
    try {
      const messages = await frames(
        await server.fetch(
          rpc("subscriptions/listen", {
            notifications: { toolsListChanged: true },
          }),
        ),
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]).toHaveProperty("error");
      expect(executed).toBe(false);
    } finally {
      await server.close();
    }
  }
});

test("subscription progress is suppressed even with a client progress token", async () => {
  const server = createMcpServer({
    serverInfo,
    auth: "public",
    providers: {
      "subscriptions/listen": {
        ...provider((_params, context) => {
          context.reportProgress(1, 2);
          return {};
        }),
        acceptSubscription: () => ({}),
      },
    },
  });
  try {
    const messages = await frames(
      await server.fetch(
        rpc("subscriptions/listen", {
          notifications: {},
          _meta: { progressToken: "token" },
        }),
      ),
    );
    expect(
      messages.some((message) => message.method === "notifications/progress"),
    ).toBe(false);
    expect(messages).toHaveLength(2);
  } finally {
    await server.close();
  }
});

test("SSE and outer errors preserve safe structured McpError data identically", async () => {
  const data = {
    capabilities: { elicitation: { form: {} } },
    retry: { permitted: true },
  };
  const failure = new McpError("Client capability required", 400, -32021, data);
  const server = createMcpServer({
    serverInfo,
    auth: "public",
    providers: {
      "tools/call": provider(() => {
        throw failure;
      }),
      "tools/list": {
        ...provider(() => ({ tools: [] })),
        schemas: () => {
          throw failure;
        },
      },
    },
  });
  try {
    const streamed = await result(
      await server.fetch(rpc("tools/call", { name: "fail" })),
    );
    const outer = await result(await server.fetch(rpc("tools/list")));
    expect(streamed.error).toEqual(outer.error);
    expect(streamed).toHaveProperty("error.data", data);
  } finally {
    await server.close();
  }
});

test("malformed requests omit unreadable IDs and retain readable IDs", async () => {
  const server = createMcpServer({ serverInfo, auth: "public" });
  const template = rpc("server/discover");
  try {
    for (const body of [
      "{",
      JSON.stringify({ jsonrpc: "2.0", id: null, method: "server/discover" }),
      JSON.stringify([{ id: 1 }]),
    ]) {
      const response = await server.fetch(
        new Request(template.url, {
          method: "POST",
          headers: template.headers,
          body,
        }),
      );
      expect(response.status).toBe(400);
      expect(await result(response)).not.toHaveProperty("id");
    }
    for (const id of ["readable-id", 0]) {
      const response = await server.fetch(
        new Request(template.url, {
          method: "POST",
          headers: template.headers,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "server/discover",
            params: [],
          }),
        }),
      );
      expect(await result(response)).toHaveProperty("id", id);
    }
  } finally {
    await server.close();
  }
});

test("runtime provider null and unknown discriminators never cross the success boundary", async () => {
  for (const resultType of [null, "unknown"]) {
    const server = createMcpServer({
      serverInfo,
      auth: "public",
      providers: {
        // @ts-expect-error Exercise malformed output from an untyped runtime provider.
        "tools/call": provider(() => ({ resultType, content: [] })),
      },
    });
    try {
      const response = await result(
        await server.fetch(rpc("tools/call", { name: "runtime" })),
      );
      expect(response).toHaveProperty("error");
      expect(response).not.toHaveProperty("result");
    } finally {
      await server.close();
    }
  }
});

test("unknown tools/call matches a denied binding without probing the catalog", async () => {
  const identity = {
    tenantId: "tenant",
    principalId: "principal",
    authorizationContextId: "grant-v1",
    scopes: [] as string[],
  };
  let executions = 0;
  let allowVisible = true;
  const seen: string[] = [];
  const providers = () =>
    createToolProviders(
      (["visible", "secret"] as const).map((name) => ({
        definition: { name, inputSchema: { type: "object" } },
        resource: `tool:${name}`,
        action: "call",
        execute: () => {
          executions++;
          return { content: [] };
        },
      })),
      "public",
    );
  const auth = {
    authenticate: () => identity,
    authorize: (
      _principal: typeof identity,
      operation: { resource: string; action: string },
    ) => {
      seen.push(`${operation.resource} ${operation.action}`);
      return (
        (operation.resource === "mcp:server" &&
          operation.action === "initialize") ||
        (allowVisible &&
          operation.resource === "tool:visible" &&
          operation.action === "call")
      );
    },
  };
  const denial = (body: string) =>
    body.trim()
      ? body
          .trim()
          .split("\n\n")
          .map((frame) => {
            const parsed = JSON.parse(
              frame.startsWith("data: ") ? frame.slice(6) : frame,
            ) as { error?: { message?: string } };
            return parsed.error?.message ?? "";
          })
          .join("\n")
      : "";
  const modern = createMcpServer({
    serverInfo,
    auth,
    providers: providers(),
  });
  try {
    const denied = await modern.fetch(
      rpc("tools/call", { name: "secret", arguments: {} }),
    );
    const unknown = await modern.fetch(
      rpc("tools/call", { name: "no-such-tool", arguments: {} }),
    );
    expect(denied.status).toBe(403);
    expect(unknown.status).toBe(denied.status);
    expect(await unknown.text()).toBe(await denied.text());
    expect(executions).toBe(0);
    const listed = await modern.fetch(rpc("tools/list"));
    expect(listed.status).toBe(200);
    expect(await result(listed)).toMatchObject({
      result: { tools: [{ name: "visible" }] },
    });
    expect(
      await result(
        await modern.fetch(
          rpc("tools/call", { name: "visible", arguments: {} }),
        ),
      ),
    ).toHaveProperty("result");
    expect(executions).toBe(1);
    allowVisible = false;
    const empty = await modern.fetch(rpc("tools/list"));
    expect(empty.status).toBe(200);
    expect(await result(empty)).toMatchObject({ result: { tools: [] } });
    const hidden = await modern.fetch(
      rpc("tools/call", { name: "secret", arguments: {} }),
    );
    const missing = await modern.fetch(
      rpc("tools/call", { name: "no-such-tool", arguments: {} }),
    );
    expect(hidden.status).toBe(403);
    expect(missing.status).toBe(hidden.status);
    expect(await missing.text()).toBe(await hidden.text());
    expect(executions).toBe(1);
  } finally {
    await modern.close();
  }

  executions = 0;
  allowVisible = true;
  const legacy = createMcpServer({
    serverInfo,
    auth,
    legacy: { versions: ["2025-11-25"] },
    providers: providers(),
  });
  const post = (body: unknown, session?: string) =>
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(session
          ? { "Mcp-Session-Id": session, "MCP-Protocol-Version": "2025-11-25" }
          : {}),
      },
      body: JSON.stringify(body),
    });
  const message = (
    id: number,
    method: string,
    params: Record<string, unknown> = {},
  ) => ({ jsonrpc: "2.0", id, method, params });
  try {
    const opened = await legacy.fetch(
      post(
        message(0, "initialize", {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        }),
      ),
    );
    expect(opened.status).toBe(200);
    const session = opened.headers.get("Mcp-Session-Id");
    if (!session) throw new Error("missing legacy session");
    expect(
      (
        await legacy.fetch(
          post(
            { jsonrpc: "2.0", method: "notifications/initialized" },
            session,
          ),
        )
      ).status,
    ).toBe(202);
    const hidden = await legacy.fetch(
      post(
        message(1, "tools/call", { name: "secret", arguments: {} }),
        session,
      ),
    );
    const missing = await legacy.fetch(
      post(
        message(2, "tools/call", { name: "no-such-tool", arguments: {} }),
        session,
      ),
    );
    const hiddenText = await hidden.text();
    const missingText = await missing.text();
    expect(hidden.status).toBe(missing.status);
    expect(denial(hiddenText)).toBe("Operation forbidden");
    expect(denial(missingText)).toBe(denial(hiddenText));
    expect(hiddenText).not.toContain("Tool unavailable");
    expect(missingText).not.toContain("Tool unavailable");
    expect(executions).toBe(0);
    const listed = await legacy.fetch(post(message(3, "tools/list"), session));
    expect(listed.status).toBe(200);
    expect(await result(listed)).toMatchObject({
      result: { tools: [{ name: "visible" }] },
    });
    allowVisible = false;
    const empty = await legacy.fetch(post(message(4, "tools/list"), session));
    expect(empty.status).toBe(200);
    expect(await result(empty)).toMatchObject({ result: { tools: [] } });
    expect(executions).toBe(0);
  } finally {
    await legacy.close();
  }
  expect(seen.some((entry) => entry.startsWith("mcp:tools"))).toBe(false);
});
