import { describe, expect, test, afterEach } from "bun:test";
import { toolApprovalEffect } from "@intx/agent";

import {
  mcpServers,
  shapeMcpContent,
  type McpServersEnv,
} from "./sidecar-bundle.js";
import { startTestMcpServer, type TestServerHandle } from "./test-server.js";
import type { McpTool } from "./client.js";

/** The mediated-fetch call signature the bundle uses; `typeof fetch`'s extra
 * members are irrelevant to it. */
type FetchStub = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

let handle: TestServerHandle | undefined;
afterEach(() => {
  handle?.stop();
  handle = undefined;
});

const CATALOG: McpTool[] = [
  { name: "echo", description: "Echoes.", inputSchema: {} },
  {
    name: "delete_thing",
    inputSchema: {},
    annotations: { destructiveHint: true },
  },
];

/** A stand-in for the host-assembled capabilities: the bundle only ever sees
 * the mediated fetch, never the bearer behind it. */
function envWith(
  handles: Record<
    string,
    { kind?: string; fetch: FetchStub; onDispose?: () => void }
  >,
): { env: McpServersEnv; resolves: string[] } {
  const resolves: string[] = [];
  const capabilities = {
    resolve: (_key: "credentials") => ({
      resolve: (name: string) => {
        resolves.push(name);
        const found = handles[name];
        if (found === undefined) {
          return Promise.reject(new Error(`no binding for "${name}"`));
        }
        return Promise.resolve({
          kind: found.kind ?? "http",
          fetch: found.fetch,
          dispose: () => found.onDispose?.(),
        });
      },
    }),
  };
  // `run` touches none of storage/audit/directors, only its own closures, so a
  // minimal same-shaped BaseEnv stub covers this call path.
  const env = {
    sources: [],
    defaultSource: "x",
    storage: {},
    workdir: "/tmp",
    audit: {},
    authorize: () => Promise.resolve({ effect: "allow", matchingGrants: [] }),
    directors: {},
    capabilities,
  } as unknown as McpServersEnv;
  return { env, resolves };
}

/** Mediated fetch: resolves a relative path against the pinned origin and
 * injects the bearer, exactly as `@corbits/credential-http` shapes it. */
function pinnedFetch(origin: string, bearer?: string) {
  const seen: Headers[] = [];
  const impl: FetchStub = (input, init) => {
    const headers = new Headers(init?.headers);
    if (bearer !== undefined) headers.set("authorization", `Bearer ${bearer}`);
    seen.push(headers);
    return fetch(new URL(String(input), origin), { ...init, headers });
  };
  return { seen, impl };
}

describe("mcpServers", () => {
  test("names every catalog entry <handle>.<tool> and floors it at ask", () => {
    const factory = mcpServers({
      servers: [
        {
          handle: "linear",
          url: "https://mcp.example.test/mcp",
          tools: CATALOG,
        },
      ],
    });
    expect(factory.definitions.map((d) => d.name).sort()).toEqual([
      "linear.delete_thing",
      "linear.echo",
    ]);
    for (const decl of factory.definitions) {
      expect(toolApprovalEffect(decl)).toBe("ask");
    }
  });

  test("allowWithoutAsk lowers a safe tool, never the destructive one", () => {
    const factory = mcpServers({
      servers: [
        {
          handle: "linear",
          url: "https://mcp.example.test/mcp",
          tools: CATALOG,
          allowWithoutAsk: ["linear.echo", "linear.delete_thing"],
        },
      ],
    });
    const byName = new Map(factory.definitions.map((d) => [d.name, d]));
    const echo = byName.get("linear.echo");
    const remove = byName.get("linear.delete_thing");
    if (echo === undefined || remove === undefined)
      throw new Error("unreachable");
    expect(toolApprovalEffect(echo)).toBe("allow");
    expect(toolApprovalEffect(remove)).toBe("ask");
  });

  test("a bad config is a construction error, not a tool error", () => {
    expect(() =>
      mcpServers({
        servers: [
          { handle: "a", url: "http://mcp.example.test/mcp", tools: [] },
        ],
      }),
    ).toThrow(/must be https/);
    expect(() =>
      mcpServers({
        servers: [
          { handle: "a", url: "https://one.example.test/mcp", tools: [] },
          { handle: "a", url: "https://two.example.test/mcp", tools: [] },
        ],
      }),
    ).toThrow(/duplicate credential handle/);
    expect(() =>
      mcpServers({
        servers: [{ handle: "", url: "https://x.test", tools: [] }],
      }),
    ).toThrow(/invalid @corbits\/mcp server config/);
  });
});

describe("shapeMcpContent", () => {
  test("text blocks come back as text, anything else as JSON", () => {
    expect(
      shapeMcpContent([
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ]),
    ).toBe("one\ntwo");
    expect(shapeMcpContent("plain")).toBe("plain");
    expect(shapeMcpContent([{ type: "image", data: "abc" }])).toBe(
      '[{"type":"image","data":"abc"}]',
    );
  });
});

describe("mcpServers round trip through a mediated handle", () => {
  test("the handle's bearer reaches the server and is resolved once", async () => {
    handle = startTestMcpServer({ requireAuth: "Bearer secret" });
    const origin = new URL(handle.url).origin;
    const { seen, impl } = pinnedFetch(origin, "secret");
    const { env, resolves } = envWith({ linear: { fetch: impl } });

    const bundle = mcpServers({
      servers: [{ handle: "linear", url: handle.url, tools: CATALOG }],
    })(env);

    const first = await bundle.run(
      { id: "1", name: "linear.echo", arguments: { text: "hi" } },
      new AbortController().signal,
    );
    expect(first.isError).toBeFalsy();
    expect(first.content).toBe("hi");

    const second = await bundle.run(
      { id: "2", name: "linear.echo", arguments: { text: "again" } },
      new AbortController().signal,
    );
    expect(second.content).toBe("again");
    // One resolve and one initialize for the whole run.
    expect(resolves).toEqual(["linear"]);
    expect(seen.every((h) => h.get("authorization") === "Bearer secret")).toBe(
      true,
    );
  });

  test("a keyless handle sends no authorization header", async () => {
    handle = startTestMcpServer();
    const origin = new URL(handle.url).origin;
    const { impl } = pinnedFetch(origin);
    const { env } = envWith({ public: { fetch: impl } });

    const bundle = mcpServers({
      servers: [{ handle: "public", url: handle.url, tools: CATALOG }],
    })(env);
    const result = await bundle.run(
      { id: "1", name: "public.echo", arguments: { text: "hi" } },
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(
      handle.requestsSeen.every((r) => !r.headers.has("authorization")),
    ).toBe(true);
  });

  test("one server's unresolvable handle fails only its own calls", async () => {
    handle = startTestMcpServer();
    const origin = new URL(handle.url).origin;
    const { impl } = pinnedFetch(origin);
    const { env } = envWith({ good: { fetch: impl } });

    const bundle = mcpServers({
      servers: [
        { handle: "good", url: handle.url, tools: CATALOG },
        {
          handle: "missing",
          url: "https://absent.example.test/mcp",
          tools: CATALOG,
        },
      ],
    })(env);

    const broken = await bundle.run(
      { id: "1", name: "missing.echo", arguments: { text: "hi" } },
      new AbortController().signal,
    );
    expect(broken.isError).toBe(true);
    expect(broken.content).toContain('no binding for "missing"');

    const working = await bundle.run(
      { id: "2", name: "good.echo", arguments: { text: "hi" } },
      new AbortController().signal,
    );
    expect(working.isError).toBeFalsy();
    expect(working.content).toBe("hi");
  });

  test("a non-http handle fails that server rather than the agent", async () => {
    const { env } = envWith({
      db: { kind: "sql", fetch: () => Promise.reject(new Error("unused")) },
    });
    const bundle = mcpServers({
      servers: [
        { handle: "db", url: "https://mcp.example.test/mcp", tools: CATALOG },
      ],
    })(env);
    const result = await bundle.run(
      { id: "1", name: "db.echo", arguments: {} },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("needs an http one");
  });

  test("dispose releases every resolved handle", async () => {
    handle = startTestMcpServer();
    const origin = new URL(handle.url).origin;
    const { impl } = pinnedFetch(origin);
    let disposed = 0;
    const { env } = envWith({
      srv: { fetch: impl, onDispose: () => (disposed += 1) },
    });
    const bundle = mcpServers({
      servers: [{ handle: "srv", url: handle.url, tools: CATALOG }],
    })(env);
    await bundle.run(
      { id: "1", name: "srv.echo", arguments: { text: "hi" } },
      new AbortController().signal,
    );
    await bundle.dispose?.();
    expect(disposed).toBe(1);
  });
});
