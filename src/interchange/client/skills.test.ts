import { expect, test } from "bun:test";
import { type } from "arktype";
import { createSkillPublisher } from "../../extensions/skills/index.js";
import { createMcpSkillConsumer } from "./skills.js";

const uri = "https://example.test/skills/example/SKILL.md";
const bytes = new TextEncoder().encode(
  "---\nname: example\ndescription: Example skill\n---\nUntrusted skill instructions: 漢字😀.\n",
);
const origin = {
  serverId: "server",
  tenantId: "tenant",
  principalId: "agent",
  authorizationContextId: "grant-version-1",
};
const Request = type({
  id: "number",
  method: "string",
  params: { "uri?": "string" },
});

async function fixture(resourceResult?: Record<string, unknown>) {
  const publisher = await createSkillPublisher([
    { uri, files: new Map([[uri, bytes]]) },
  ]);
  const methods: string[] = [];
  return {
    methods,
    client: {
      fetch: async (
        _input: string | URL | globalThis.Request,
        init?: RequestInit,
      ) => {
        const request = Request.assert(JSON.parse(String(init?.body)));
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
              ? publisher.get(request.params.uri ?? "")
              : (resourceResult ?? publisher.read(request.params.uri ?? ""));
        return Response.json({ jsonrpc: "2.0", id: request.id, result });
      },
    },
  };
}

test("verified skill bytes are not activation when host policy is absent", async () => {
  const { client, methods } = await fixture();
  const consumer = createMcpSkillConsumer({ origin, url: "/mcp", client });
  const held = await consumer.get(uri);
  const verified = await consumer.verify(held);
  expect(verified.bytes).toEqual(bytes);
  expect(verified.trust).toBe("untrusted-mcp");
  expect(held.origin).toEqual(origin);
  await expect(consumer.activate(held)).rejects.toThrow(
    "host policy unavailable",
  );
  expect(methods).toEqual(["server/discover", "skills/get", "resources/read"]);
});

test("host activation installs execution gate before context and removes context before release", async () => {
  const { client } = await fixture();
  const events: string[] = [];
  const consumer = createMcpSkillConsumer({
    origin,
    url: "/mcp",
    client,
    host: {
      approve: async (held) => {
        events.push("approve");
        return {
          identity: held.identity,
          fingerprint: held.fingerprint,
          approved: true,
          execution: false,
        };
      },
      openActingWindow: async () => {
        events.push("gate");
        return {
          admit: async () => {
            events.push("admit");
          },
          removeContext: async () => {
            events.push("remove");
          },
          close: async () => {
            events.push("close");
          },
        };
      },
    },
  });
  const lease = await consumer.activate(await consumer.get(uri));
  expect(events).toEqual(["approve", "gate", "admit"]);
  expect(() => lease.assertExecutionApproved()).toThrow("execution approval");
  await lease.release();
  expect(events).toEqual(["approve", "gate", "admit", "remove", "close"]);
  await expect(lease.read(uri)).rejects.toThrow("closed");
});

test("mismatched skill approval cannot admit context", async () => {
  const { client } = await fixture();
  let admitted = false;
  const consumer = createMcpSkillConsumer({
    origin,
    url: "/mcp",
    client,
    host: {
      approve: async (held) => ({
        identity: "another-principal",
        fingerprint: held.fingerprint,
        approved: true,
        execution: true,
      }),
      openActingWindow: async () => {
        admitted = true;
        throw new Error("must not enter");
      },
    },
  });
  await expect(consumer.activate(await consumer.get(uri))).rejects.toThrow(
    "denied or mismatched",
  );
  expect(admitted).toBe(false);
});

for (const encoding of ["text", "blob"] as const) {
  test(`skill ${encoding} manifest budget cancels before response EOF`, async () => {
    const { client } = await fixture();
    const mediatedFetch = client.fetch;
    let consumed = 0;
    let eof = false;
    let cancelled = false;
    let wireLength = 0;
    client.fetch = async (input, init) => {
      const request = Request.assert(JSON.parse(String(init?.body)));
      if (request.method !== "resources/read")
        return mediatedFetch(input, init);
      const payload = "x".repeat(200 * 1024);
      const wire = new TextEncoder().encode(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            contents: [
              {
                uri,
                [encoding]: encoding === "text" ? payload : btoa(payload),
              },
            ],
          },
        }),
      );
      wireLength = wire.length;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (consumed === wire.length) {
              eof = true;
              controller.close();
              return;
            }
            const end = Math.min(consumed + 1024, wire.length);
            controller.enqueue(wire.slice(consumed, end));
            consumed = end;
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    };
    const consumer = createMcpSkillConsumer({ origin, url: "/mcp", client });
    await expect(consumer.verify(await consumer.get(uri))).rejects.toThrow(
      /limit|size|budget/,
    );
    expect(cancelled).toBe(true);
    expect(eof).toBe(false);
    expect(consumed).toBeLessThan(wireLength / 4);
  });
}

test("skill blob decoding accepts the exact UTF-8 manifest size", async () => {
  const { client } = await fixture({
    contents: [{ uri, blob: Buffer.from(bytes).toString("base64") }],
  });
  const consumer = createMcpSkillConsumer({ origin, url: "/mcp", client });
  expect((await consumer.verify(await consumer.get(uri))).bytes).toEqual(bytes);
});
for (const resource of [
  { uri, blob: "a===" },
  { uri: "test://wrong", text: new TextDecoder().decode(bytes) },
  { uri, text: "short" },
]) {
  test(`skill final validation rejects ${JSON.stringify(resource)}`, async () => {
    const { client } = await fixture({ contents: [resource] });
    const consumer = createMcpSkillConsumer({ origin, url: "/mcp", client });
    await expect(consumer.verify(await consumer.get(uri))).rejects.toThrow();
  });
}
