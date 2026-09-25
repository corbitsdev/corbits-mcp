import { describe, expect, test, afterEach } from "bun:test";
import { toolApprovalEffect } from "@intx/agent";
import {
  createCredentialCapability,
  createCredentialProviderRegistry,
} from "@intx/harness";
import type { GrantRule } from "@intx/authz";

import { mcpTools } from "./tool.js";
import { isAskExempt, qualifiedName } from "./naming.js";
import { startTestMcpServer, type TestServerHandle } from "./test-server.js";
import type { McpTool } from "./client.js";

let handle: TestServerHandle | undefined;
afterEach(() => {
  handle?.stop();
  handle = undefined;
});

describe("qualifiedName", () => {
  test("joins server and remote tool name", () => {
    expect(qualifiedName("linear", "list_issues")).toBe("linear.list_issues");
  });
});

describe("ask-mark derivation (CL-8392)", () => {
  const safeTool: McpTool = { name: "echo", inputSchema: {} };
  const destructiveTool: McpTool = {
    name: "delete_thing",
    inputSchema: {},
    annotations: { destructiveHint: true },
  };

  test("a plain remote tool is ask-exempt only when explicitly allow-listed", () => {
    expect(isAskExempt("srv.echo", safeTool, [])).toBe(false);
    expect(isAskExempt("srv.echo", safeTool, ["srv.echo"])).toBe(true);
  });

  test("destructiveHint wins over allowWithoutAsk", () => {
    expect(
      isAskExempt("srv.delete_thing", destructiveTool, ["srv.delete_thing"]),
    ).toBe(false);
  });
});

describe("mcpTools discovers a live server and floors every tool at ask", () => {
  test("an allow grant still resolves to ask unless the tool is allow-listed", async () => {
    handle = startTestMcpServer();
    const factory = await mcpTools({
      servers: [{ name: "srv", url: handle.url }],
    });

    expect(factory.definitions.map((d) => d.name).sort()).toEqual([
      "srv.delete_thing",
      "srv.echo",
    ]);
    for (const decl of factory.definitions) {
      expect(toolApprovalEffect(decl)).toBe("ask");
    }
  });

  test("allowWithoutAsk lowers the mark for a named safe tool, never for the destructive one", async () => {
    handle = startTestMcpServer();
    const factory = await mcpTools({
      servers: [{ name: "srv", url: handle.url }],
      allowWithoutAsk: ["srv.echo", "srv.delete_thing"],
    });

    const byName = new Map(factory.definitions.map((d) => [d.name, d]));
    const echoDecl = byName.get("srv.echo");
    const deleteDecl = byName.get("srv.delete_thing");
    expect(echoDecl).toBeDefined();
    expect(deleteDecl).toBeDefined();
    if (echoDecl === undefined || deleteDecl === undefined)
      throw new Error("unreachable");
    expect(toolApprovalEffect(echoDecl)).toBe("allow");
    expect(toolApprovalEffect(deleteDecl)).toBe("ask");
  });

  test("built bundle proxies tools/call over the discovered server", async () => {
    handle = startTestMcpServer();
    const factory = await mcpTools({
      servers: [{ name: "srv", url: handle.url }],
    });
    // The factory's env-DI contract requires a full BaseEnv, but this bundle's
    // `run` touches none of storage/audit/directors -- only its own closures --
    // so a minimal same-shaped stub is sufficient for this call path.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const bundle = factory({
      sources: [],
      defaultSource: "x",
      storage: {},
      workdir: "/tmp",
      audit: {},
      authorize: () => Promise.resolve({ effect: "allow", matchingGrants: [] }),
      directors: {},
    } as unknown as Parameters<typeof factory>[0]);

    const result = await bundle.run(
      { id: "1", name: "srv.echo", arguments: { text: "hi" } },
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe("hi");
  });
});

describe("env.credentials wiring: mcpTools resolves a server's fetch through the standard capability", () => {
  test("a bound credential's fetch is used for tools/call", async () => {
    handle = startTestMcpServer({ requireAuth: "Bearer secret" });
    const grants: GrantRule[] = [
      {
        id: "g1",
        resource: "credential:cred-1",
        action: "use",
        effect: "allow",
        origin: "system",
        conditions: { tool: "@corbits/mcp/servers" },
        roleId: null,
        principalId: null,
        expiresAt: null,
      },
    ];
    const providers = createCredentialProviderRegistry([
      {
        key: "bearer",
        shape: () => ({
          kind: "http" as const,
          fetch: (input: string | URL | Request, init?: RequestInit) =>
            fetch(input, {
              ...init,
              headers: { ...init?.headers, authorization: "Bearer secret" },
            }),
          dispose: () => undefined,
        }),
      },
    ]);
    const bindings = new Map([
      [
        "mcp-server",
        {
          credentialId: "cred-1",
          providerKey: "bearer",
          origin: new URL(handle.url).origin,
          readCurrentMaterial: () => ({ secret: "secret" }),
        },
      ],
    ]);
    const credentials = createCredentialCapability({
      consumer: "@corbits/mcp/servers",
      bindings,
      providers,
      grants,
    });

    const factory = await mcpTools(
      {
        servers: [
          { name: "srv", url: handle.url, credentialHandle: "mcp-server" },
        ],
      },
      { credentials },
    );
    // Minimal same-shaped BaseEnv stub; see the identical note above.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const bundle = factory({
      sources: [],
      defaultSource: "x",
      storage: {},
      workdir: "/tmp",
      audit: {},
      authorize: () => Promise.resolve({ effect: "allow", matchingGrants: [] }),
      directors: {},
      credentials,
    } as unknown as Parameters<typeof factory>[0]);

    const result = await bundle.run(
      { id: "1", name: "srv.echo", arguments: { text: "hi" } },
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe("hi");
  });
});

describe("credential isolation (CL-8392): the declared handle binds only to @corbits/mcp", () => {
  test("a different consumer cannot resolve the mcp-server credential", async () => {
    const grants: GrantRule[] = [
      {
        id: "g1",
        resource: "credential:cred-1",
        action: "use",
        effect: "allow",
        origin: "system",
        conditions: { tool: "@corbits/mcp/servers" },
        roleId: null,
        principalId: null,
        expiresAt: null,
      },
    ];
    const providers = createCredentialProviderRegistry([
      {
        key: "http",
        shape: () => ({
          kind: "http" as const,
          fetch: () => Promise.reject(new Error("unused in this test")),
          dispose: () => undefined,
        }),
      },
    ]);
    const bindings = new Map([
      [
        "mcp-server",
        {
          credentialId: "cred-1",
          providerKey: "http",
          origin: "https://example.com",
          readCurrentMaterial: () => ({ secret: "s3cr3t" }),
        },
      ],
    ]);

    const forMcp = createCredentialCapability({
      consumer: "@corbits/mcp/servers",
      bindings,
      providers,
      grants,
    });
    await expect(forMcp.resolve("mcp-server")).resolves.toBeDefined();

    const forOtherTool = createCredentialCapability({
      consumer: "@corbits/some-other-tool",
      bindings,
      providers,
      grants,
    });
    await expect(forOtherTool.resolve("mcp-server")).rejects.toThrow(
      /not authorized/,
    );
  });
});
