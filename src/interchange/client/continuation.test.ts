import { createAppHostBridge } from "../../extensions/apps.js";
import { expect, test } from "bun:test";
import { fromToolRunner } from "@intx/agent";
import { type } from "arktype";
import { mcpTools, type McpToolsEnv } from "../../tool.js";
import { mcpServers, type McpServersEnv } from "../../sidecar-bundle.js";
import type { McpHostServices } from "./contracts.js";
import type { McpTool } from "../../client.js";

const RequestBody = type({
  id: "number",
  method: "string",
  "params?": "Record<string, unknown>",
});
const base = {
  sources: [],
  defaultSource: "test",
  storage: {},
  workdir: "/tmp",
  audit: {},
  authorize: async () => ({ effect: "allow", matchingGrants: [] }),
  directors: {},
};
const tool: McpTool = {
  name: "count",
  inputSchema: { type: "object", properties: {} },
  outputSchema: {
    type: "object",
    properties: { count: { type: "integer" } },
    required: ["count"],
  },
};

async function bundleFor(
  mode: "live" | "stored",
  url: string,
  host: McpHostServices,
  extensions?: string[],
) {
  if (mode === "live") {
    const factory = await mcpTools({
      servers: [{ name: "s", url }],
      host,
      ...(extensions === undefined ? {} : { extensions }),
    });
    return factory(base as unknown as McpToolsEnv);
  }
  return mcpServers({
    servers: [{ handle: "s", url, tools: [tool] }],
    host,
    ...(extensions === undefined ? {} : { extensions }),
  })({
    ...base,
    capabilities: {
      resolve: () => ({
        resolve: async () => ({
          kind: "http",
          fetch: (input: string | URL | Request, init?: RequestInit) =>
            fetch(new URL(String(input), url), init),
          dispose() {},
        }),
      }),
    },
  } as unknown as McpServersEnv);
}

for (const mode of ["live", "stored"] as const) {
  for (const rounds of [0, 1, 2]) {
    for (const valid of [false, true]) {
      test(`${mode}: ${rounds} continuation rounds ${valid ? "accept valid" : "reject invalid"} catalog output`, async () => {
        let calls = 0;
        let answers = 0;
        let presentations = 0;
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
            else if (body.method === "tools/list") result = { tools: [tool] };
            else {
              calls++;
              result =
                calls <= rounds
                  ? {
                      resultType: "input_required",
                      inputRequests: {},
                      requestState: `round-${calls}`,
                    }
                  : {
                      content: [],
                      structuredContent: { count: valid ? 1 : "invalid" },
                    };
            }
            return Response.json({ jsonrpc: "2.0", id: body.id, result });
          },
        });
        try {
          const bundle = await bundleFor(
            mode,
            new URL("mcp", server.url).href,
            {
              requestInput: async () => {
                answers++;
                return {};
              },
              presentResult: async () => {
                presentations++;
              },
            },
          );
          const agentTool = fromToolRunner(bundle)[0];
          if (agentTool?.kind !== "full")
            throw new Error("Expected Interchange full tool handler");
          const result = await agentTool.handler(
            { id: "call", name: "s.count", arguments: {} },
            new AbortController().signal,
          );
          expect(calls).toBe(rounds + 1);
          expect(answers).toBe(rounds);
          expect(result.isError).toBe(!valid);
          expect(presentations).toBe(valid ? 1 : 0);
          if (valid)
            expect(result.detail).toMatchObject({
              mcp: { structuredContent: { count: 1 } },
            });
          else expect(result.detail).toBeUndefined();
          await bundle.dispose?.();
        } finally {
          server.stop(true);
        }
      });
    }
  }

  test(`${mode}: UI plus form capabilities survive two genuine elicitation rounds`, async () => {
    const requests: Record<string, unknown>[] = [];
    const messages: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const body = RequestBody.assert(await request.json());
        let result: unknown;
        if (body.method === "server/discover")
          result = {
            supportedVersions: ["2026-07-28"],
            capabilities: {
              tools: {},
              extensions: { "io.modelcontextprotocol/ui": {} },
            },
          };
        else if (body.method === "tools/list") result = { tools: [tool] };
        else {
          requests.push(body.params ?? {});
          const round = requests.length;
          result =
            round <= 2
              ? {
                  resultType: "input_required",
                  requestState: `state-${round}`,
                  inputRequests: {
                    [`question-${round}`]: {
                      method: "elicitation/create",
                      params: {
                        mode: "form",
                        message: `Question ${round}`,
                        requestedSchema: {
                          type: "object",
                          properties: { answer: { type: "string" } },
                          required: ["answer"],
                        },
                      },
                    },
                  },
                }
              : {
                  content: [{ type: "text", text: "Finished" }],
                  structuredContent: { count: 2 },
                };
        }
        return Response.json({ jsonrpc: "2.0", id: body.id, result });
      },
    });
    try {
      const bundle = await bundleFor(
        mode,
        new URL("mcp", server.url).href,
        {
          elicitation: {
            form: async (request) => {
              messages.push(request.message);
              return { action: "accept", content: { answer: request.message } };
            },
          },
          // Explicit test host only; no renderer is supplied by the adapter.
          apps: {
            support: {
              sandboxRenderer: true,
              cspEnforcement: true,
              authenticatedBridge: true,
            },
            bridge: createAppHostBridge({
              async mount() {
                return { async close() {} };
              },
              async authorizeTool() {},
              async callTool() {
                return {};
              },
            }),
          },
          presentResult: async () => {},
        },
        ["io.modelcontextprotocol/ui"],
      );
      const result = await bundle.run(
        { id: "call", name: "s.count", arguments: {} },
        new AbortController().signal,
      );
      expect(result.isError).toBe(false);
      expect(result.content).toBe("Finished");
      expect(messages).toEqual(["Question 1", "Question 2"]);
      expect(requests).toHaveLength(3);
      for (const request of requests) {
        expect(request._meta).toMatchObject({
          "io.modelcontextprotocol/clientCapabilities": {
            elicitation: { form: {} },
            extensions: {
              "io.modelcontextprotocol/ui": {
                mimeTypes: ["text/html;profile=mcp-app"],
              },
            },
          },
        });
      }
      expect(requests[1]).toMatchObject({
        requestState: "state-1",
        inputResponses: {
          "question-1": { action: "accept", content: { answer: "Question 1" } },
        },
      });
      expect(requests[2]).toMatchObject({
        requestState: "state-2",
        inputResponses: {
          "question-2": { action: "accept", content: { answer: "Question 2" } },
        },
      });
      await bundle.dispose?.();
    } finally {
      server.stop(true);
    }
  });
}
