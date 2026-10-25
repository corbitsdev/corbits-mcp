import { expect, spyOn, test } from "bun:test";
import { createMcpServer } from "../server.js";
import type { McpAuthPolicy } from "../auth/contracts.js";
import type { McpLegacyRevision } from "./contracts.js";

const identity = {
  tenantId: "tenant",
  principalId: "principal",
  authorizationContextId: "grants",
  scopes: [],
};
const serverInfo = { name: "legacy-lifecycle-regressions", version: "1" };
const revisions: McpLegacyRevision[] = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
];
function initialize(bodyVersion: string, headerVersion?: string) {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(headerVersion === undefined
        ? {}
        : { "MCP-Protocol-Version": headerVersion }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: bodyVersion,
        capabilities: {},
        clientInfo: { name: "regression", version: "1" },
      },
    }),
  });
}

for (const version of revisions)
  test(`${version} rejects invalid initialization headers before authorization or allocation`, async () => {
    let authorizations = 0;
    const auth: McpAuthPolicy = {
      authenticate: () => identity,
      authorize: () => {
        authorizations++;
        return true;
      },
    };
    const endpoint = createMcpServer({
      serverInfo,
      auth,
      legacy: { versions: [version], maxSessions: 1 },
    });
    const timer = spyOn(globalThis, "setTimeout");
    try {
      for (const header of [
        "",
        "malformed",
        "2099-01-01",
        "2024-11-05",
        ...revisions.filter((candidate) => candidate !== version),
      ]) {
        const response = await endpoint.fetch(initialize(version, header));
        expect(response.status).toBe(400);
        expect(response.headers.has("Mcp-Session-Id")).toBe(false);
      }
      expect(authorizations).toBe(0);
      expect(timer).not.toHaveBeenCalled();
      // Unsupported body revisions still negotiate when the transport header is absent.
      const negotiated = await endpoint.fetch(initialize("2099-01-01"));
      expect(negotiated.status).toBe(200);
      expect(await negotiated.json()).toMatchObject({
        result: { protocolVersion: version },
      });
      expect(authorizations).toBe(1);
      const session = negotiated.headers.get("Mcp-Session-Id")!;
      expect(
        (
          await endpoint.fetch(
            new Request("http://localhost/mcp", {
              method: "DELETE",
              headers: {
                "Mcp-Session-Id": session,
                "MCP-Protocol-Version": version,
              },
            }),
          )
        ).status,
      ).toBe(204);
      expect((await endpoint.fetch(initialize(version, version))).status).toBe(
        200,
      );
    } finally {
      timer.mockRestore();
      await endpoint.close();
    }
  });

for (const phase of ["authenticate", "authorize"] as const)
  test(`close during initialize ${phase} cannot resurrect sessions or timers`, async () => {
    let entered!: () => void;
    let resume!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let authorizations = 0;
    const auth: McpAuthPolicy = {
      async authenticate() {
        if (phase === "authenticate") {
          entered();
          await pending;
        }
        return identity;
      },
      async authorize() {
        authorizations++;
        if (phase === "authorize") {
          entered();
          await pending;
        }
        return true;
      },
    };
    const endpoint = createMcpServer({
      serverInfo,
      auth,
      legacy: { maxSessions: 1 },
    });
    const timer = spyOn(globalThis, "setTimeout");
    try {
      const response = endpoint.fetch(initialize("2025-11-25"));
      await started;
      await endpoint.close();
      await endpoint.close();
      resume();
      const closed = await response;
      expect(closed.status).toBe(503);
      expect(closed.headers.has("Mcp-Session-Id")).toBe(false);
      expect(timer).not.toHaveBeenCalled();
      expect(authorizations).toBe(phase === "authenticate" ? 0 : 1);
      expect((await endpoint.fetch(initialize("2025-11-25"))).status).toBe(503);
      await endpoint.close();
      expect(timer).not.toHaveBeenCalled();
    } finally {
      resume();
      timer.mockRestore();
      await endpoint.close();
    }
  });

test("close during DELETE authentication remains terminal after verifier resumes", async () => {
  let entered!: () => void;
  let resume!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const auth: McpAuthPolicy = {
    async authenticate(request) {
      if (request.method === "DELETE") {
        entered();
        await pending;
      }
      return identity;
    },
    authorize: () => true,
  };
  const endpoint = createMcpServer({ serverInfo, auth, legacy: {} });
  try {
    const initialized = await endpoint.fetch(initialize("2025-11-25"));
    const session = initialized.headers.get("Mcp-Session-Id")!;
    const response = endpoint.fetch(
      new Request("http://localhost/mcp", {
        method: "DELETE",
        headers: {
          "Mcp-Session-Id": session,
          "MCP-Protocol-Version": "2025-11-25",
        },
      }),
    );
    await started;
    await endpoint.close();
    resume();
    expect((await response).status).toBe(503);
    await endpoint.close();
  } finally {
    resume();
    await endpoint.close();
  }
});
