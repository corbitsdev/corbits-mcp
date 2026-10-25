import { expect, test } from "bun:test";
import {
  createDefaultDirectorRegistry,
  createToolRunner,
  defineTool,
  tool,
  type BaseEnv,
} from "@intx/agent";
import { noopAuditStore, permissiveAuthorize } from "@intx/agent/testing";
import {
  createCredentialCapability,
  createCredentialProviderRegistry,
  createHttpCredentialProvider,
} from "@intx/harness";
import { mcpCallTool, mcpConnect, mcpListTools } from "../src/client.js";
import { createMcpServer } from "../src/server.js";
import { createInterchangeProviders } from "../src/interchange/server.js";
import { mcpTools } from "../src/tool.js";
import type { McpAuthPolicy } from "../src/auth/contracts.js";

// No inference is performed: use real ToolBundle/runner and credential mediation.
// Access to unrelated agent storage fails rather than pretending to implement it.
function toolEnv(): BaseEnv {
  return {
    sources: [],
    defaultSource: "unused",
    workdir: "/unused",
    get storage(): never {
      throw new Error("This tool-only test must not access inference storage");
    },
    audit: noopAuditStore(),
    authorize: permissiveAuthorize(),
    directors: createDefaultDirectorRegistry(),
  };
}

function fixture() {
  let executions = 0;
  let permitted = true;
  let approved = true;
  const inputSchema = {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  };
  const factory = defineTool({
    id: "@example/roundtrip/tools",
    definitions: [{ name: "internal.echo" }, { name: "internal.secret" }],
    factory: () =>
      createToolRunner([
        tool({
          definition: {
            name: "internal.echo",
            description: "Echo text",
            inputSchema,
          },
          handler: async (call) => {
            executions++;
            return {
              callId: call.id,
              content: String(call.arguments.text),
              detail: { privateNote: "host-only" },
            };
          },
        }),
        tool({
          definition: {
            name: "internal.secret",
            description: "Not exposed",
            inputSchema,
          },
          handler: async () => {
            throw new Error("Unselected tool executed");
          },
        }),
      ]),
  });
  const auth: McpAuthPolicy = {
    authenticate: (request) =>
      request.headers.get("authorization") === "Bearer integration-secret"
        ? {
            tenantId: "tenant-a",
            principalId: "principal-a",
            scopes: ["tools"],
            authorizationContextId: "partition-a",
          }
        : null,
    authorize: (_identity, operation) =>
      operation.resource === "mcp:tools" || permitted,
  };
  const server = createMcpServer({
    serverInfo: { name: "interchange-roundtrip", version: "1" },
    auth,
    providers: createInterchangeProviders({
      auth,
      exposures: [
        {
          kind: "tool",
          definition: {
            name: "echo",
            description: "Selected echo",
            inputSchema,
          },
          tenantId: "tenant-a",
          resource: "tool:internal.echo",
          action: "invoke",
          approve: async () => approved,
          bundle: factory(toolEnv()),
          toolName: "internal.echo",
        },
      ],
    }),
  });
  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: server.fetch,
  });
  const url = new URL("/mcp", http.url).href;
  const credentials = createCredentialCapability({
    consumer: "@corbits/mcp/servers",
    providers: createCredentialProviderRegistry([
      createHttpCredentialProvider(),
    ]),
    bindings: new Map([
      [
        "mcp-server",
        {
          credentialId: "credential-a",
          providerKey: "http",
          origin: http.url.origin,
          readCurrentMaterial: () => ({ secret: "integration-secret" }),
        },
      ],
    ]),
    grants: [
      {
        id: "credential-grant",
        resource: "credential:credential-a",
        action: "use",
        effect: "allow",
        origin: "system",
        conditions: { tool: "@corbits/mcp/servers" },
        roleId: null,
        principalId: null,
        expiresAt: null,
      },
    ],
  });
  return {
    url,
    credentials,
    executions: () => executions,
    revoke: () => {
      permitted = false;
    },
    denyApproval: () => {
      approved = false;
    },
    async close() {
      http.stop(true);
      await server.close();
    },
  };
}

test("selected real Interchange tool is callable over modern MCP, not the whole bundle", async () => {
  const f = fixture();
  try {
    const handle = await f.credentials.resolve("mcp-server");
    const options = { fetch: handle.fetch.bind(handle) };
    const session = await mcpConnect(f.url, options);
    expect(session.protocolVersion).toBe("2026-07-28");
    expect(session.sessionId).toBeUndefined();
    const tools = await mcpListTools(f.url, { ...options, session });
    expect(tools.map((tool) => tool.name)).toEqual(["echo"]);
    const result = await mcpCallTool(
      f.url,
      "echo",
      { text: "hello" },
      { ...options, session },
    );
    expect(result).toMatchObject({
      content: [{ type: "text", text: "hello" }],
    });
    expect(JSON.stringify(result)).not.toContain("host-only");
    expect(f.executions()).toBe(1);
    await expect(
      mcpCallTool(f.url, "echo", { text: 42 }, options),
    ).rejects.toThrow();
    await expect(
      mcpCallTool(f.url, "internal.secret", { text: "no" }, options),
    ).rejects.toThrow();
    expect(f.executions()).toBe(1);
    f.revoke();
    expect(await mcpListTools(f.url, options)).toEqual([]);
    await expect(
      mcpCallTool(f.url, "echo", { text: "denied" }, options),
    ).rejects.toThrow();
    expect(f.executions()).toBe(1);
    await expect(handle.fetch("https://other.example/mcp")).rejects.toThrow();
  } finally {
    await f.close();
  }
});

test("MCP consumption round-trips through actual Interchange factories and rechecks approval", async () => {
  const f = fixture();
  try {
    const consume = await mcpTools(
      {
        servers: [
          { name: "remote", url: f.url, credentialHandle: "mcp-server" },
        ],
      },
      { credentials: f.credentials },
    );
    expect(consume.definitions).toEqual([
      { name: "remote.echo", approval: "ask" },
    ]);
    const bundle = consume(
      Object.assign(toolEnv(), { credentials: f.credentials }),
    );
    const signal = new AbortController().signal;
    const call = {
      id: "roundtrip",
      name: "remote.echo",
      arguments: { text: "through both directions" },
    };
    const result = await bundle.run(call, signal);
    expect(result.isError).not.toBe(true);
    expect(result.content).toBe("through both directions");
    expect(JSON.stringify(result)).not.toContain("integration-secret");
    expect(f.executions()).toBe(1);
    f.denyApproval();
    expect((await bundle.run(call, signal)).isError).toBe(true);
    expect(f.executions()).toBe(1);
    await bundle.dispose?.();
  } finally {
    await f.close();
  }
});
