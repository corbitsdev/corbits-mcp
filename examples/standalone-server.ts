import { createMcpServer, createToolProviders } from "@corbits/mcp/server";

const server = createMcpServer({
  serverInfo: { name: "public-loopback-echo", version: "1" },
  auth: "public",
  providers: createToolProviders(
    [
      {
        definition: {
          name: "echo",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
            additionalProperties: false,
          },
        },
        resource: "example:echo",
        action: "invoke",
        execute: (args) => ({
          content: [{ type: "text", text: String(args.text) }],
        }),
      },
    ],
    "public",
  ),
});
const http = Bun.serve({
  hostname: "127.0.0.1",
  port: 3000,
  fetch: server.fetch,
});
console.log(new URL("/mcp", http.url).href);
process.once("SIGINT", () => {
  http.stop(true);
  void server.close();
});
