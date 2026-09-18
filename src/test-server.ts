// In-test streamable-HTTP MCP server (`echo`, and `delete_thing` flagged
// `destructiveHint`) so the suite needs no network.

import { type } from "arktype";

export interface TestServerHandle {
  url: string;
  requestsSeen: Request[];
  stop(): void;
}

const JsonRpcRequestBody = type({
  id: "number",
  method: "string",
  "params?": "Record<string, unknown>",
});

const ToolCallParams = type({
  name: "string",
  arguments: "Record<string, unknown>",
});

export function startTestMcpServer(
  opts: { requireAuth?: string } = {},
): TestServerHandle {
  const requestsSeen: Request[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      requestsSeen.push(req);
      if (
        opts.requireAuth !== undefined &&
        req.headers.get("authorization") !== opts.requireAuth
      ) {
        return new Response("unauthorized", { status: 401 });
      }
      const parsedBody = JsonRpcRequestBody(await req.json());
      if (parsedBody instanceof type.errors) {
        return new Response("bad request", { status: 400 });
      }
      const body = parsedBody;
      const reply = (result: unknown) =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
          headers: { "content-type": "application/json" },
        });

      if (body.method === "initialize") {
        return reply({
          protocolVersion: "2025-03-26",
          capabilities: {},
          serverInfo: { name: "test", version: "0" },
        });
      }
      if (body.method === "tools/list") {
        return reply({
          tools: [
            {
              name: "echo",
              description: "Echoes the given text back.",
              inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
              },
            },
            {
              name: "delete_thing",
              description: "Deletes a thing by id.",
              inputSchema: {
                type: "object",
                properties: { id: { type: "string" } },
                required: ["id"],
              },
              annotations: { destructiveHint: true },
            },
          ],
        });
      }
      if (body.method === "tools/call") {
        const params = ToolCallParams(body.params);
        if (params instanceof type.errors) {
          return new Response("bad request", { status: 400 });
        }
        if (params.name === "echo") {
          return reply({ content: params.arguments.text });
        }
        if (params.name === "delete_thing") {
          return reply({ content: `deleted ${String(params.arguments.id)}` });
        }
        return reply({ content: `unknown tool ${params.name}`, isError: true });
      }
      return new Response("not found", { status: 404 });
    },
  });

  return {
    url: new URL("mcp", server.url).toString(),
    requestsSeen,
    stop: () => {
      void server.stop(true);
    },
  };
}
