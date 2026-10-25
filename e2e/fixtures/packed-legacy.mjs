import assert from "node:assert/strict";
import { createMcpServer } from "@corbits/mcp/server";

for (const version of ["2025-11-25", "2025-06-18", "2025-03-26"]) {
  const server = createMcpServer({
    serverInfo: { name: "packed-legacy", version: "1" },
    auth: "public",
    legacy: { versions: [version], maxSessions: 1, sessionTtlMs: 60_000 },
  });
  const post = (body, session) =>
    server.fetch(
      new Request("https://mcp.example/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(session
            ? { "Mcp-Session-Id": session, "MCP-Protocol-Version": version }
            : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: version,
      capabilities: {},
      clientInfo: { name: "packed", version: "1" },
    },
  };
  try {
    const response = await post(initialize);
    assert.equal(response.status, 200);
    const session = response.headers.get("Mcp-Session-Id");
    assert.ok(session);
    assert.equal((await response.json()).result.protocolVersion, version);
    const ready = await post(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      session,
    );
    assert.equal(ready.status, 202);
    assert.equal(
      (await post(initialize)).status,
      503,
      "configured session capacity is enforced",
    );
    assert.equal(
      (
        await server.fetch(
          new Request("https://mcp.example/mcp", {
            headers: {
              "Mcp-Session-Id": session,
              "MCP-Protocol-Version": version,
            },
          }),
        )
      ).status,
      405,
      "legacy GET streams are unsupported",
    );
  } finally {
    await server.close();
  }
}
console.log("packed legacy APIs passed");
