import { expect, test } from "bun:test";
import { createMcpServer, createSkillProviders } from "../../server.js";
import { mcpReadResource } from "../../client.js";
import { MCP_EXT_SKILLS } from "../../protocol/index.js";
import { type } from "arktype";
import { createSkillPublisher } from "../../extensions/skills/index.js";
import { createMcpSkillConsumer } from "./skills.js";

const uri = "skill://large/SKILL.md";
const RpcRequest = type({ id: "number", method: "string" });
const origin = {
  serverId: "large-server",
  tenantId: "tenant",
  principalId: "agent",
  authorizationContextId: "grant",
};

// Deliberately sequential: exercise the actual manifest -> client -> decoder ->
// digest verification boundary without multiplying peak large-buffer usage.
for (const size of [4 * 1024 * 1024, 16 * 1024 * 1024]) {
  for (const encoding of ["text", "blob"] as const) {
    for (const sse of [false, true]) {
      test(`skill ${size} bytes ${encoding} verifies (SSE=${sse})`, async () => {
        const header = "---\nname: large\ndescription: Large skill\n---\n";
        const text = header + "x".repeat(size - header.length);
        const bytes = new TextEncoder().encode(text);
        const publisher = await createSkillPublisher([
          { uri, files: new Map([[uri, bytes]]) },
        ]);
        const methods: string[] = [];
        const consumer = createMcpSkillConsumer({
          origin,
          url: "/mcp",
          client: {
            fetch: async (_input, init) => {
              const request = RpcRequest.assert(JSON.parse(String(init?.body)));
              methods.push(request.method);
              const result =
                request.method === "server/discover"
                  ? {
                      supportedVersions: ["2026-07-28"],
                      capabilities: {
                        resources: {},
                        extensions: { "io.modelcontextprotocol/skills": {} },
                      },
                    }
                  : request.method === "skills/get"
                    ? publisher.get(uri)
                    : {
                        contents: [
                          {
                            uri,
                            [encoding]:
                              encoding === "text"
                                ? text
                                : Buffer.from(bytes).toString("base64"),
                          },
                        ],
                      };
              const json = JSON.stringify({
                jsonrpc: "2.0",
                id: request.id,
                result,
              });
              const streaming = sse && request.method === "resources/read";
              const wire = new TextEncoder().encode(
                streaming ? `data: ${json}\n\n` : json,
              );
              let offset = 0;
              return new Response(
                new ReadableStream<Uint8Array>({
                  pull(controller) {
                    if (offset === wire.length) {
                      controller.close();
                      return;
                    }
                    const end = Math.min(offset + 64 * 1024, wire.length);
                    controller.enqueue(wire.subarray(offset, end));
                    offset = end;
                  },
                }),
                {
                  headers: {
                    "content-type": streaming
                      ? "text/event-stream"
                      : "application/json",
                  },
                },
              );
            },
          },
        });
        const held = await consumer.get(uri);
        const verified = await consumer.verify(held);
        expect(verified.bytes.byteLength).toBe(size);
        expect(
          Buffer.compare(Buffer.from(verified.bytes), Buffer.from(bytes)),
        ).toBe(0);
        expect(verified.trust).toBe("untrusted-mcp");
        expect(methods).toEqual([
          "server/discover",
          "skills/get",
          "resources/read",
        ]);
      }, 30_000);
    }
  }
}

for (const size of [4 * 1024 * 1024, 16 * 1024 * 1024]) {
  for (const encoding of ["text", "blob"] as const) {
    test(`real Skills publisher/server/consumer ${size} ${encoding}`, async () => {
      const header = "---\nname: large\ndescription: Large skill\n---\n";
      const text = header + "x".repeat(size - header.length);
      const bytes = new TextEncoder().encode(text);
      const publisher = await createSkillPublisher([
        { uri, files: new Map([[uri, bytes]]) },
      ]);
      const providers = { ...createSkillProviders(publisher, "skills:large") };
      if (encoding === "text")
        providers["resources/read"] = {
          resource: "skills:large",
          action: "read",
          handle: () => ({ contents: [{ uri, text }] }),
        };
      const server = createMcpServer({
        auth: "public",
        serverInfo: { name: "large", version: "1" },
        extensions: { [MCP_EXT_SKILLS]: { directoryRead: true } },
        providers,
      });
      try {
        const consumer = createMcpSkillConsumer({
          origin,
          url: "https://large.test/mcp",
          client: {
            fetch: async (input, init) =>
              server.fetch(
                input instanceof Request
                  ? new Request(input, init)
                  : new Request(String(input), init),
              ),
          },
        });
        const verified = await consumer.verify(await consumer.get(uri));
        expect(verified.bytes.byteLength).toBe(size);
        expect(
          Buffer.compare(Buffer.from(verified.bytes), Buffer.from(bytes)),
        ).toBe(0);
        expect(verified.trust).toBe("untrusted-mcp");
      } finally {
        await server.close();
      }
    }, 30_000);
  }
}

test("server emission retains default limits and rejects oversized Skills payloads/metadata", async () => {
  for (const kind of ["default", "decoded", "metadata"] as const) {
    const publisher = await createSkillPublisher([
      {
        uri,
        files: new Map([
          [
            uri,
            new TextEncoder().encode(
              "---\nname: large\ndescription: Large skill\n---\n",
            ),
          ],
        ]),
      },
    ]);
    const read = {
      resource: "skills:large",
      action: "read",
      handle: () => ({
        contents: [
          {
            uri,
            text: "x".repeat(
              kind === "default"
                ? 4 * 1024 * 1024
                : kind === "decoded"
                  ? 16 * 1024 * 1024 + 1
                  : 0,
            ),
          },
        ],
        ...(kind === "metadata"
          ? { _meta: { huge: "x".repeat(64 * 1024) } }
          : {}),
      }),
    };
    const server = createMcpServer({
      auth: "public",
      serverInfo: { name: "large", version: "1" },
      ...(kind === "default"
        ? {}
        : { extensions: { [MCP_EXT_SKILLS]: { directoryRead: true } } }),
      providers: {
        ...(kind === "default"
          ? {}
          : createSkillProviders(publisher, "skills:large")),
        "resources/read": read,
      },
    });
    try {
      await expect(
        mcpReadResource("https://large.test/mcp", uri, {
          maxDecodedBytes: 16 * 1024 * 1024,
          fetch: async (input, init) =>
            server.fetch(
              input instanceof Request
                ? new Request(input, init)
                : new Request(String(input), init),
            ),
        }),
      ).rejects.toThrow(
        kind === "default"
          ? "JSON byte limit"
          : kind === "decoded"
            ? "decoded byte limit"
            : "metadata/envelope",
      );
    } finally {
      await server.close();
    }
  }
});
