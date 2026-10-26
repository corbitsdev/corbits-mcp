import { expect, test } from "bun:test";
import { fromToolRunner } from "@intx/agent";
import { ToolResult } from "@intx/types/runtime";
import { type } from "arktype";
import { mcpTools, type McpToolsEnv } from "../../tool.js";
import { mcpServers, type McpServersEnv } from "../../sidecar-bundle.js";
import type { McpHostServices } from "./contracts.js";

const RequestBody = type({
  id: "number",
  method: "string",
  "params?": "Record<string, unknown>",
});
const tools = [{ name: "echo", inputSchema: { type: "object" } }];
const base = {
  sources: [],
  defaultSource: "x",
  storage: {},
  workdir: "/tmp",
  audit: {},
  authorize: async () => ({ effect: "allow", matchingGrants: [] }),
  directors: {},
};

for (const mode of ["live", "stored"] as const) {
  test(`${mode}: explicit host continuation preserves rich result and original arguments`, async () => {
    const calls: Record<string, unknown>[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const body = RequestBody.assert(await request.json());
        let result: unknown;
        if (body.method === "server/discover")
          result = {
            supportedVersions: ["2026-07-28"],
            capabilities: { tools: {} },
          };
        else if (body.method === "tools/list") result = { tools };
        else {
          calls.push(body.params ?? {});
          result =
            calls.length === 1
              ? {
                  resultType: "input_required",
                  requestState: "opaque",
                  inputRequests: {},
                }
              : {
                  content: [{ type: "text", text: "done" }],
                  structuredContent: { value: 7 },
                  _meta: { private: "ui-only" },
                };
        }
        return Response.json({ jsonrpc: "2.0", id: body.id, result });
      },
    });
    try {
      const url = new URL("mcp", server.url).href;
      let presentations = 0;
      const host: McpHostServices = {
        requestInput: async (context, pending) => {
          expect(context.tool).toBe("srv.echo");
          expect(pending.requestState).toBe("opaque");
          return {};
        },
        presentResult: async (_context, result) => {
          expect(result._meta).toEqual({ private: "ui-only" });
          presentations++;
        },
      };
      const bundle =
        mode === "live"
          ? (await mcpTools({ servers: [{ name: "srv", url }], host }))(
              base as unknown as McpToolsEnv,
            )
          : mcpServers({ servers: [{ handle: "srv", url, tools }], host })({
              ...base,
              capabilities: {
                resolve: () => ({
                  resolve: async () => ({
                    kind: "http",
                    fetch: (
                      input: string | URL | Request,
                      init?: RequestInit,
                    ) => fetch(new URL(String(input), server.url), init),
                    dispose() {},
                  }),
                }),
              },
            } as unknown as McpServersEnv);
      const agentTool = fromToolRunner(bundle)[0];
      if (agentTool?.kind !== "full")
        throw new Error("Expected actual AgentTool full handler");
      const result = await agentTool.handler(
        { id: "c", name: "srv.echo", arguments: { original: true } },
        new AbortController().signal,
      );
      expect(ToolResult.allows(result)).toBe(true);
      expect(result.isError).toBe(false);
      expect(result.content).toBe("done");
      expect(result.detail).toMatchObject({
        mcp: { structuredContent: { value: 7 }, _meta: { private: "ui-only" } },
      });
      expect(calls).toHaveLength(2);
      for (const call of calls) {
        expect(JSON.stringify(call._meta)).not.toContain(
          "io.modelcontextprotocol/ui",
        );
      }
      expect(calls[1]).toMatchObject({
        name: "echo",
        arguments: { original: true },
        requestState: "opaque",
        inputResponses: {},
      });
      expect(presentations).toBe(1);
      await bundle.dispose?.();
    } finally {
      server.stop(true);
    }
  });
}

test("stored construction stays synchronous and freshness rejection precedes credential resolution", async () => {
  let resolved = false;
  const factory = mcpServers({
    servers: [{ handle: "s", url: "https://example.test/mcp", tools }],
    host: {
      validateCatalog: async () => {
        throw new Error("catalog needs reapproval");
      },
    },
  });
  const bundle = factory({
    ...base,
    capabilities: {
      resolve: () => {
        resolved = true;
        throw new Error("must not resolve");
      },
    },
  } as unknown as McpServersEnv);
  expect(bundle).not.toBeInstanceOf(Promise);
  const result = await bundle.run(
    { id: "c", name: "s.echo", arguments: {} },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toBe("catalog needs reapproval");
  expect(resolved).toBe(false);
});

test("factories refuse to advertise host capabilities they cannot implement", async () => {
  for (const id of ["tasks", "ui", "skills"]) {
    const extensions = [`io.modelcontextprotocol/${id}`];
    expect(() => mcpServers({ servers: [], extensions })).toThrow();
    await expect(mcpTools({ servers: [], extensions })).rejects.toThrow();
  }
});

test("stored catalog output schema is enforced, not merely preserved", async () => {
  const factory = mcpServers({
    servers: [
      {
        handle: "s",
        url: "https://example.test/mcp",
        tools: [
          {
            name: "echo",
            inputSchema: { type: "object" },
            outputSchema: {
              type: "object",
              properties: { count: { type: "integer" } },
              required: ["count"],
            },
          },
        ],
      },
    ],
  });
  const bundle = factory({
    ...base,
    capabilities: {
      resolve: () => ({
        resolve: async () => ({
          kind: "http",
          dispose() {},
          fetch: async (_input: unknown, init?: RequestInit) => {
            const body = RequestBody.assert(JSON.parse(String(init?.body)));
            const result =
              body.method === "server/discover"
                ? {
                    supportedVersions: ["2026-07-28"],
                    capabilities: { tools: {} },
                  }
                : {
                    content: [],
                    structuredContent: { count: "not-an-integer" },
                  };
            return Response.json({ jsonrpc: "2.0", id: body.id, result });
          },
        }),
      }),
    },
  } as unknown as McpServersEnv);
  const result = await bundle.run(
    { id: "c", name: "s.echo", arguments: {} },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
});

for (const mode of ["live", "stored"] as const) {
  test(`${mode}: app-only tools are neither exposed nor dispatchable by the model`, async () => {
    let remoteCalls = 0;
    const catalog = [
      {
        name: "visible",
        inputSchema: { type: "object" },
        _meta: { ui: { visibility: ["model", "app"] } },
      },
      {
        name: "hidden",
        inputSchema: { type: "object" },
        _meta: { ui: { visibility: ["app"] } },
      },
    ];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const body = RequestBody.assert(await request.json());
        const result =
          body.method === "server/discover"
            ? { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } }
            : body.method === "tools/list"
              ? { tools: catalog }
              : (remoteCalls++,
                { content: [{ type: "text", text: "must not run" }] });
        return Response.json({ jsonrpc: "2.0", id: body.id, result });
      },
    });
    try {
      const url = new URL("mcp", server.url).href;
      const factory =
        mode === "live"
          ? await mcpTools({
              servers: [{ name: "s", url }],
              host: { presentResult: async () => {} },
            })
          : mcpServers({
              servers: [{ handle: "s", url, tools: catalog }],
              host: { presentResult: async () => {} },
            });
      expect(factory.definitions.map((tool) => tool.name)).toEqual([
        "s.visible",
      ]);
      const bundle = factory({
        ...base,
        capabilities: {
          resolve: () => {
            throw new Error("hidden tool must not resolve credentials");
          },
        },
      } as unknown as McpServersEnv);
      expect(bundle.definitions.map((tool) => tool.name)).toEqual([
        "s.visible",
      ]);
      const result = await bundle.run(
        { id: "c", name: "s.hidden", arguments: {} },
        new AbortController().signal,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("unknown MCP tool");
      expect(remoteCalls).toBe(0);
    } finally {
      server.stop(true);
    }
  });
}

test("configured form elicitation advertises only form and sends an explicit decline", async () => {
  let answered = false;
  const factory = mcpServers({
    servers: [{ handle: "s", url: "https://example.test/mcp", tools }],
    host: { elicitation: { form: async () => ({ action: "decline" }) } },
  });
  const bundle = factory({
    ...base,
    capabilities: {
      resolve: () => ({
        resolve: async () => ({
          kind: "http",
          dispose() {},
          fetch: async (_input: unknown, init?: RequestInit) => {
            const body = RequestBody.assert(JSON.parse(String(init?.body)));
            expect(body.params?._meta).toMatchObject({
              "io.modelcontextprotocol/clientCapabilities": {
                elicitation: { form: {} },
              },
            });
            let result: unknown;
            if (body.method === "server/discover")
              result = {
                supportedVersions: ["2026-07-28"],
                capabilities: { tools: {} },
              };
            else if (body.params?.inputResponses === undefined)
              result = {
                resultType: "input_required",
                inputRequests: {
                  consent: {
                    method: "elicitation/create",
                    params: {
                      message: "Consent?",
                      requestedSchema: { type: "object", properties: {} },
                    },
                  },
                },
              };
            else {
              expect(body.params.inputResponses).toEqual({
                consent: { action: "decline" },
              });
              answered = true;
              result = { content: [{ type: "text", text: "User declined." }] };
            }
            return Response.json({ jsonrpc: "2.0", id: body.id, result });
          },
        }),
      }),
    },
  } as unknown as McpServersEnv);
  const result = await bundle.run(
    { id: "c", name: "s.echo", arguments: {} },
    new AbortController().signal,
  );
  expect(result.content).toBe("User declined.");
  expect(answered).toBe(true);
});

test("malformed UI visibility cannot silently expose a stored tool", () => {
  expect(() =>
    mcpServers({
      servers: [
        {
          handle: "s",
          url: "https://example.test/mcp",
          tools: [
            {
              name: "hidden",
              inputSchema: { type: "object" },
              _meta: { ui: { visibility: "app" } },
            },
          ],
        },
      ],
    }),
  ).toThrow("visibility");
});
