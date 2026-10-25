import { expect, test } from "bun:test";
import { createCatalogGuard } from "./catalog.js";
import type { McpTool } from "../../client.js";

const context = {
  server: "s",
  url: "https://example.test/mcp",
  tool: "s.echo",
  callId: "c",
  signal: new AbortController().signal,
};
const tool: McpTool = { name: "echo", inputSchema: { type: "object" } };

test("freshness refreshes only after expiry and changed schemas require rebuild", async () => {
  let now = 0;
  let refreshes = 0;
  const guard = createCatalogGuard({
    now: () => now,
    refresh: async () => {
      refreshes++;
      return {
        tools: [
          refreshes === 1
            ? tool
            : { ...tool, inputSchema: { type: "object", required: ["new"] } },
        ],
        expiresAt: now + 10,
      };
    },
  });
  await guard(context, tool);
  await guard(context, tool);
  expect(refreshes).toBe(1);
  now = 10;
  await expect(guard(context, tool)).rejects.toThrow("rebuild");
  expect(refreshes).toBe(2);
});

test("refresh cannot silently change approval policy, visibility or remove a tool", async () => {
  for (const tools of [
    [],
    [{ ...tool, annotations: { destructiveHint: true } }],
    [{ ...tool, _meta: { ui: { visibility: ["app"] } } }],
  ]) {
    const guard = createCatalogGuard({
      refresh: async () => ({ tools, expiresAt: Date.now() + 10000 }),
    });
    await expect(guard(context, tool)).rejects.toThrow("rebuild");
  }
});

test("expired refresh fails closed and can be retried", async () => {
  let expiresAt = 0;
  const guard = createCatalogGuard({
    now: () => 1,
    refresh: async () => ({ tools: [tool], expiresAt }),
  });
  await expect(guard(context, tool)).rejects.toThrow("expired");
  expiresAt = 2;
  await guard(context, tool);
});
