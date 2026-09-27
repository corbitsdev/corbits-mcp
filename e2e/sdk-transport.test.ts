// Discovery and tool calls against the official SDK's streamable-HTTP server
// transport, in both its stateless and stateful (session id) modes.

import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { mcpTools } from "../src/tool.js";
import { mcpServers, type McpServersEnv } from "../src/sidecar-bundle.js";
import { discoverMcpServer } from "../src/hub/discover.js";

let http: Server | undefined;
afterEach(() => {
  http?.close();
  http = undefined;
});

async function startSdkServer(stateful: boolean): Promise<string> {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  http = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
    const sid = req.headers["mcp-session-id"];
    let transport = typeof sid === "string" ? transports.get(sid) : undefined;
    if (transport === undefined) {
      // The SDK's option types predate exactOptionalPropertyTypes.
      const created = new StreamableHTTPServerTransport({
        sessionIdGenerator: stateful ? () => randomUUID() : undefined,
        onsessioninitialized: (id: string) => {
          transports.set(id, created);
        },
      } as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);
      const server = new McpServer({ name: "sdk", version: "1" });
      server.registerTool(
        "echo",
        { inputSchema: { text: z.string() } },
        ({ text }) => ({ content: [{ type: "text", text }] }),
      );
      await server.connect(created as Parameters<McpServer["connect"]>[0]);
      transport = created;
    }
    await transport.handleRequest(req, res, body);
  });
  const listening = http;
  await new Promise<void>((resolve) =>
    listening.listen(0, "127.0.0.1", resolve),
  );
  const address = listening.address();
  if (address === null || typeof address === "string") {
    throw new Error("the SDK server has no port");
  }
  return `http://127.0.0.1:${String(address.port)}/mcp`;
}

// `run` touches only its own closures and the credentials capability, so a
// minimal same-shaped env covers this call path.
function sidecarEnv(origin: string): McpServersEnv {
  const credential = {
    kind: "http",
    fetch: (input: string | URL | Request, init?: RequestInit) =>
      fetch(new URL(String(input), origin), init),
    dispose: () => undefined,
  };
  return {
    capabilities: {
      resolve: () => ({ resolve: () => Promise.resolve(credential) }),
    },
  } as unknown as McpServersEnv;
}

const call = { id: "c1", name: "sdk.echo", arguments: { text: "hi" } };

describe.each([
  ["stateless", false],
  ["stateful", true],
])("the SDK's %s streamable-HTTP transport", (_, stateful) => {
  test("discovery reads the catalog", async () => {
    const url = await startSdkServer(stateful);
    const found = await discoverMcpServer({ url });
    expect(found.serverInfo.serverInfo?.name).toBe("sdk");
    expect(found.tools.map((t) => t.name)).toEqual(["echo"]);
  });

  test("the sidecar bundle calls a tool", async () => {
    const url = await startSdkServer(stateful);
    const { tools } = await discoverMcpServer({ url });
    const bound = mcpServers({ servers: [{ handle: "sdk", url, tools }] })(
      sidecarEnv(new URL(url).origin),
    );
    const result = await bound.run(call, new AbortController().signal);
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.content)).toContain("hi");
  });

  test("mcpTools calls a tool", async () => {
    const url = await startSdkServer(stateful);
    const factory = await mcpTools({ servers: [{ name: "sdk", url }] });
    const bound = factory({} as never);
    const result = await bound.run(call, new AbortController().signal);
    expect(result.isError).toBe(false);
    expect(String(result.content)).toContain("hi");
  });
});
