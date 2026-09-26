import { describe, expect, test, afterEach } from "bun:test";
import { MCP_NO_TOKEN_SENTINEL } from "@corbits/credential-http";
import type { TenantEnv } from "@intx/hub-api";
import { Hono } from "hono";

import { mountMcpDiscovery, type MountMcpDiscoveryOpts } from "./discover.js";
import { startTestMcpServer, type TestServerHandle } from "../test-server.js";

let handle: TestServerHandle | undefined;
afterEach(() => {
  handle?.stop();
  handle = undefined;
});

/**
 * Mount the route on a tenant router the way a host does, with a stub for the
 * one credential read it performs. The gate is the host's own middleware, so
 * the test supplies a pass-through and asserts the route's own behavior.
 */
function appWith(
  secrets: Record<string, string>,
  opts: {
    readonly apiBaseUrl?: string | null;
    readonly extraOrigins?: Record<string, string[]>;
  } = {},
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();
  app.use("*", async (c, next) => {
    (c as unknown as { set(k: string, v: unknown): void }).set("tenant", {
      id: "tnt_1",
    });
    await next();
  });
  const row = (id: string) =>
    secrets[id] === undefined
      ? []
      : [{ id, secret: secrets[id], apiBaseUrl: opts.apiBaseUrl ?? null }];
  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: (_clause: unknown) => ({
            // The stub cannot read drizzle's clause, so the id is threaded
            // through the only credential the test registers.
            limit: () =>
              Promise.resolve(row(Object.keys(secrets)[0] ?? "none")),
          }),
        }),
      }),
    }),
  };
  const cipher = { decrypt: (value: string) => Promise.resolve(value) };
  // Only the narrow `db.select` chain and `cipher.decrypt` are exercised here.
  const mountOpts = {
    db,
    cipher,
    requireGrant: async (_c: unknown, next: () => Promise<void>) => {
      await next();
    },
    extraOrigins: opts.extraOrigins,
  } as unknown as MountMcpDiscoveryOpts;
  mountMcpDiscovery(app, mountOpts);
  return app;
}

async function post(
  app: Hono<TenantEnv>,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await app.request("/mcp/discover", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json: unknown = await response.json().catch(() => ({}));
  // The route always answers JSON; the cast narrows it for assertions.
  return { status: response.status, json: json as Record<string, unknown> };
}

describe("POST /mcp/discover", () => {
  test("a keyless server's catalog comes back with no authorization sent", async () => {
    handle = startTestMcpServer();
    const { status, json } = await post(appWith({}), { url: handle.url });
    expect(status).toBe(200);
    const data = json["data"] as {
      serverInfo: { serverInfo?: { name: string } };
      tools: { name: string }[];
    };
    expect(data.tools.map((t) => t.name).sort()).toEqual([
      "delete_thing",
      "echo",
    ]);
    expect(data.serverInfo.serverInfo?.name).toBe("test");
    expect(
      handle.requestsSeen.every((r) => !r.headers.has("authorization")),
    ).toBe(true);
  });

  test("a credential's secret is sent as a bearer", async () => {
    handle = startTestMcpServer({ requireAuth: "Bearer tok-1" });
    const { status } = await post(
      appWith({ cred_1: "tok-1" }, { apiBaseUrl: handle.url }),
      {
        url: handle.url,
        credentialId: "cred_1",
      },
    );
    expect(status).toBe(200);
    expect(
      handle.requestsSeen.every(
        (r) => r.headers.get("authorization") === "Bearer tok-1",
      ),
    ).toBe(true);
  });

  test("the keyless sentinel sends no authorization header", async () => {
    handle = startTestMcpServer();
    const { status } = await post(
      appWith({ cred_1: MCP_NO_TOKEN_SENTINEL }, { apiBaseUrl: handle.url }),
      {
        url: handle.url,
        credentialId: "cred_1",
      },
    );
    expect(status).toBe(200);
    expect(
      handle.requestsSeen.every((r) => !r.headers.has("authorization")),
    ).toBe(true);
  });

  test("a bad body, a plain-http host and an unknown credential are all 4xx", async () => {
    const app = appWith({});
    expect((await post(app, {})).status).toBe(400);
    expect(
      (await post(app, { url: "http://mcp.example.test/mcp" })).status,
    ).toBe(400);
    const missing = await post(app, {
      url: "https://mcp.example.test/mcp",
      credentialId: "cred_absent",
    });
    expect(missing.status).toBe(404);
  });

  test("a server that fails to initialize is a 4xx that never echoes a secret", async () => {
    handle = startTestMcpServer({ requireAuth: "Bearer right" });
    const { status, json } = await post(
      appWith({ cred_1: "wrong" }, { apiBaseUrl: handle.url }),
      {
        url: handle.url,
        credentialId: "cred_1",
      },
    );
    expect(status).toBe(422);
    expect(JSON.stringify(json)).not.toContain("wrong");
  });

  test("a credential is never sent off its origin unless the host allows it", async () => {
    handle = startTestMcpServer({ requireAuth: "Bearer tok-1" });
    const pinned = "https://mcp.example.test";
    const refused = await post(
      appWith({ cred_1: "tok-1" }, { apiBaseUrl: `${pinned}/api` }),
      { url: handle.url, credentialId: "cred_1" },
    );
    expect(refused.status).toBe(422);
    expect(String(refused.json["error"])).toContain(
      `credential is pinned to ${pinned}`,
    );
    expect(handle.requestsSeen).toHaveLength(0);

    const otherPin = await post(
      appWith(
        { cred_1: "tok-1" },
        {
          apiBaseUrl: pinned,
          extraOrigins: { "https://other.example.test": [handle.url] },
        },
      ),
      { url: handle.url, credentialId: "cred_1" },
    );
    expect(otherPin.status).toBe(422);
    expect(handle.requestsSeen).toHaveLength(0);

    const allowed = await post(
      appWith(
        { cred_1: "tok-1" },
        {
          apiBaseUrl: pinned,
          extraOrigins: { [`${pinned}/`]: [handle.url] },
        },
      ),
      { url: handle.url, credentialId: "cred_1" },
    );
    expect(allowed.status).toBe(200);
    expect(handle.requestsSeen.length).toBeGreaterThan(0);
  });

  test("a credential whose provider has no API origin is refused", async () => {
    handle = startTestMcpServer();
    const { status } = await post(appWith({ cred_1: "tok-1" }), {
      url: handle.url,
      credentialId: "cred_1",
    });
    expect(status).toBe(422);
    expect(handle.requestsSeen).toHaveLength(0);
  });

  test("a keyless credential needs no API origin", async () => {
    handle = startTestMcpServer();
    const { status } = await post(appWith({ cred_1: MCP_NO_TOKEN_SENTINEL }), {
      url: handle.url,
      credentialId: "cred_1",
    });
    expect(status).toBe(200);
  });

  test("a redirect is refused even to an allowed origin", async () => {
    handle = startTestMcpServer();
    const target = handle.url;
    const redirector = Bun.serve({
      port: 0,
      fetch: () => Response.redirect(target, 307),
    });
    try {
      const pinned = redirector.url.origin;
      const { status, json } = await post(
        appWith(
          { cred_1: "tok-1" },
          { apiBaseUrl: pinned, extraOrigins: { [pinned]: [target] } },
        ),
        { url: new URL("/mcp", pinned).href, credentialId: "cred_1" },
      );
      expect(status).toBe(422);
      expect(String(json["error"])).toContain("redirect");
      expect(handle.requestsSeen).toHaveLength(0);
    } finally {
      await redirector.stop(true);
    }
  });
});
