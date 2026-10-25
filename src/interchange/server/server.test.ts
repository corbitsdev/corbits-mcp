import { expect, test } from "bun:test";
import { stringTool } from "@intx/agent";
import { Hono } from "hono";
import { createInterchangeProviders } from "../server.js";
import { createMcpServer } from "../../server.js";
import { rpc, result } from "../../server/fixtures.js";
import type {
  InterchangeExposure,
  InterchangeToolExposure,
} from "./contracts.js";
import type { McpAuthPolicy } from "../../auth/contracts.js";

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
  description: "Selected operation",
  inputSchema: {
    type: "object",
    properties: { content: { type: "string" } },
    required: ["content"],
    additionalProperties: false,
  },
};
const base = {
  definition,
  tenantId: "tenant",
  resource: "tool:selected",
  action: "call",
  approve: async () => true,
};
function server(exposures: InterchangeExposure[], policy = auth) {
  return createMcpServer({
    serverInfo: { name: "interchange", version: "1" },
    auth: policy,
    providers: createInterchangeProviders({ auth: policy, exposures }),
  });
}

test("installed AgentTool handler is exposed only by explicit selection and preserves ask gate", async () => {
  let calls = 0;
  const installed = stringTool({
    definition,
    handler: async (args) => {
      calls++;
      return String(args.content);
    },
  });
  if (installed.kind !== "string") throw new Error("Expected string tool");
  const exposure: InterchangeToolExposure = {
    ...base,
    kind: "tool",
    toolName: "selected",
    bundle: {
      definitions: [definition, { ...definition, name: "private" }],
      run: async (call, signal) => ({
        callId: call.id,
        content: await installed.handler(call.arguments, signal),
      }),
    },
  };
  const endpoint = server([exposure]);
  expect(await result(await endpoint.fetch(rpc("tools/list")))).toMatchObject({
    result: { tools: [{ name: "selected" }] },
  });
  expect(
    await result(
      await endpoint.fetch(
        rpc("tools/call", {
          name: "selected",
          arguments: { content: "hello" },
        }),
      ),
    ),
  ).toMatchObject({ result: { content: [{ text: "hello" }] } });
  const denied = server([{ ...exposure, approve: async () => false }]);
  expect(
    await result(
      await denied.fetch(
        rpc("tools/call", { name: "selected", arguments: { content: "no" } }),
      ),
    ),
  ).toHaveProperty("error");
  expect(calls).toBe(1);
  const otherTenant = server([exposure], {
    ...auth,
    authenticate: () => ({ ...identity, tenantId: "other" }),
  });
  expect(
    await result(await otherTenant.fetch(rpc("tools/list"))),
  ).toMatchObject({ result: { tools: [] } });
  await endpoint.close();
  await denied.close();
  await otherTenant.close();
});

test("authored operation invokes Hono pipeline with bound tenant and no MCP bearer forwarding", async () => {
  const app = new Hono();
  let calls = 0;
  app.post("/api/tenants/tenant/selected", async (context) => {
    calls++;
    expect(context.req.header("authorization")).toBeUndefined();
    return context.json({ accepted: await context.req.json() });
  });
  const endpoint = server([
    {
      ...base,
      kind: "operation",
      method: "POST",
      origin: "https://hub.example",
      path: "/api/tenants/tenant/selected",
      body: (args) => ({ content: args.content }),
      dispatch: async (request, principal) => {
        expect(principal).toEqual(identity);
        return app.fetch(request);
      },
    },
  ]);
  expect(
    await result(
      await endpoint.fetch(
        rpc(
          "tools/call",
          { name: "selected", arguments: { content: "hello" } },
          { Authorization: "Bearer mcp-only" },
        ),
      ),
    ),
  ).toMatchObject({
    result: { structuredContent: { accepted: { content: "hello" } } },
  });
  expect(
    await result(
      await endpoint.fetch(
        rpc("tools/call", {
          name: "selected",
          arguments: { content: "hello", tenantId: "evil" },
        }),
      ),
    ),
  ).toHaveProperty("error");
  expect(calls).toBe(1);
  await endpoint.close();
});

test("workflow persists intent before actual mail route and selects only correlated result", async () => {
  const events: string[] = [];
  const endpoint = server([
    {
      ...base,
      kind: "workflow",
      origin: "https://hub.example",
      deploymentId: "deployment",
      message: (args) => String(args.content),
      prepare: async () => {
        events.push("persist-intent");
        return "intent-1";
      },
      dispatch: async (request) => {
        events.push("dispatch");
        expect(new URL(request.url).pathname).toBe(
          "/api/tenants/tenant/workflows/deployment/mail",
        );
        expect(await request.json()).toEqual({ content: "hello" });
        return Response.json(
          { runId: "run-1", address: "run@example", messageId: "message-1" },
          { status: 202 },
        );
      },
      recordTrigger: async (intent, trigger) => {
        expect(intent).toBe("intent-1");
        expect(trigger.messageId).toBe("message-1");
        events.push("persist-correlation");
      },
      selectResult: async (trigger) => {
        expect(trigger.runId).toBe("run-1");
        events.push("select");
        return { content: [{ type: "text", text: "correlated answer" }] };
      },
    },
  ]);
  expect(
    await result(
      await endpoint.fetch(
        rpc("tools/call", {
          name: "selected",
          arguments: { content: "hello" },
        }),
      ),
    ),
  ).toMatchObject({ result: { content: [{ text: "correlated answer" }] } });
  expect(events).toEqual([
    "persist-intent",
    "dispatch",
    "persist-correlation",
    "select",
  ]);
  await endpoint.close();
});

test("agent suspension is delegated without approval fabrication or shared agent close", async () => {
  let suspended = false;
  const endpoint = server([
    {
      ...base,
      kind: "agent",
      message: (args) => String(args.content),
      agent: {
        send: async (_content, options) => {
          expect(options?.signal).toBeInstanceOf(AbortSignal);
          return { type: "suspended", correlationId: "approval-1" };
        },
      },
      suspended: async (pending) => {
        suspended = true;
        expect(pending.correlationId).toBe("approval-1");
        return { content: [{ type: "text", text: "Awaiting host approval" }] };
      },
    },
  ]);
  await result(
    await endpoint.fetch(
      rpc("tools/call", { name: "selected", arguments: { content: "hello" } }),
    ),
  );
  expect(suspended).toBe(true);
  await endpoint.close();
});

test("traversal, unbound paths, cross-origin paths and unresolved schemas fail before publication", () => {
  for (const path of [
    "//evil.example/x",
    "/api/../admin",
    "/api/%2e%2e/admin",
    "/api/{tenantId}/x",
    "/api/%252e%252e/admin",
  ]) {
    expect(() =>
      server([
        {
          ...base,
          kind: "operation",
          method: "POST",
          origin: "https://hub.example",
          path,
          dispatch: async () => Response.json({}),
        },
      ]),
    ).toThrow();
  }
  expect(() =>
    server([
      {
        ...base,
        definition: {
          ...definition,
          inputSchema: { $ref: "https://evil.example/schema" },
        },
        kind: "operation",
        method: "GET",
        origin: "https://hub.example",
        path: "/safe",
        dispatch: async () => Response.json({}),
      },
    ]),
  ).toThrow();
});

test("exposure resource and action are the only tool authorization pair", async () => {
  const seen: string[] = [];
  let executions = 0;
  let approvals = 0;
  let permitted = true;
  const policy: McpAuthPolicy = {
    authenticate: () => identity,
    authorize: (_principal, operation) => {
      seen.push(`${operation.resource} ${operation.action}`);
      return (
        permitted &&
        operation.resource === base.resource &&
        operation.action === base.action
      );
    },
  };
  const endpoint = server(
    [
      {
        ...base,
        kind: "tool",
        toolName: "selected",
        approve: async () => {
          approvals++;
          return true;
        },
        bundle: {
          definitions: [definition],
          run: async (call) => {
            executions++;
            return { callId: call.id, content: "ran" };
          },
        },
      },
    ],
    policy,
  );
  const discovered = await endpoint.fetch(rpc("server/discover"));
  expect(discovered.status).toBe(200);
  expect(await result(discovered)).toMatchObject({
    result: {
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "interchange" } },
    },
  });
  expect(await result(await endpoint.fetch(rpc("tools/list")))).toMatchObject({
    result: { tools: [{ name: "selected" }] },
  });
  expect(
    await result(
      await endpoint.fetch(
        rpc("tools/call", { name: "selected", arguments: { content: "x" } }),
      ),
    ),
  ).toMatchObject({ result: { content: [{ text: "ran" }] } });
  expect(approvals).toBe(1);
  expect(executions).toBe(1);
  expect(seen.every((entry) => entry === "tool:selected call")).toBe(true);
  permitted = false;
  const denied = await endpoint.fetch(rpc("server/discover"));
  expect(denied.status).toBe(403);
  expect(await denied.text()).not.toContain("interchange");
  expect(await result(await endpoint.fetch(rpc("tools/list")))).toMatchObject({
    result: { tools: [] },
  });
  expect(
    (
      await endpoint.fetch(
        rpc("tools/call", { name: "selected", arguments: { content: "x" } }),
      )
    ).status,
  ).toBe(403);
  expect(approvals).toBe(1);
  expect(executions).toBe(1);
  expect(seen.some((entry) => entry.startsWith("mcp:tools"))).toBe(false);
  await endpoint.close();
});
