import { expect, test } from "bun:test";
import { createResourceBudget } from "./resource-budget.js";
import { mcpReadResource, McpError } from "../client.js";
import type { FetchLike } from "../protocol/types.js";

const uri = "test://bounded";
function streamed(result: unknown, sse = false, escape = false): FetchLike {
  return async (_url, init) => {
    const { id } = JSON.parse(String(init?.body)) as { id: number };
    let json = JSON.stringify({ jsonrpc: "2.0", id, result });
    if (escape)
      json = json.replace(
        /[^\x20-\x7e]/g,
        (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
      );
    const wire = new TextEncoder().encode(
      sse ? `: comment\r\nevent: message\r\ndata: ${json}\r\n\r\n` : json,
    );
    let offset = 0;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset === wire.length) {
            controller.close();
            return;
          }
          controller.enqueue(wire.slice(offset, offset + 1));
          offset++;
        },
      }),
      {
        headers: {
          "content-type": sse ? "text/event-stream" : "application/json",
        },
      },
    );
  };
}
for (const sse of [false, true]) {
  for (const text of ["", "a", "é", "😀", "\ud800", '"\\\n', "漢字😀"]) {
    test(`bounded UTF-8 ${JSON.stringify(text)} (SSE=${sse})`, async () => {
      const result = {
        contents: [{ uri, text, _meta: { source: "kept" } }],
        _meta: { trace: "kept" },
      };
      const maxDecodedBytes = Buffer.byteLength(text);
      for (const escape of [false, true]) {
        const actual = await mcpReadResource("/mcp", uri, {
          fetch: streamed(result, sse, escape),
          maxDecodedBytes,
        });
        expect(actual).toMatchObject(result);
        if (maxDecodedBytes > 0)
          await expect(
            mcpReadResource("/mcp", uri, {
              fetch: streamed(result, sse, escape),
              maxDecodedBytes: maxDecodedBytes - 1,
            }),
          ).rejects.toThrow(/limit|budget/);
      }
    });
  }
  for (const text of ["", "a", "ab", "abc", "abcd"]) {
    test(`bounded base64 length ${text.length} (SSE=${sse})`, async () => {
      const result = { contents: [{ uri, blob: btoa(text) }] };
      expect(
        await mcpReadResource("/mcp", uri, {
          fetch: streamed(result, sse),
          maxDecodedBytes: text.length,
        }),
      ).toMatchObject(result);
      if (text.length)
        await expect(
          mcpReadResource("/mcp", uri, {
            fetch: streamed(result, sse),
            maxDecodedBytes: text.length - 1,
          }),
        ).rejects.toThrow(/limit|budget/);
    });
  }
}
test("bounded reads preserve RPC errors and authentication challenges", async () => {
  const fetch: FetchLike = async (_url, init) => {
    const { id } = JSON.parse(String(init?.body)) as { id: number };
    return Response.json({
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: "resource unavailable" },
    });
  };
  await expect(
    mcpReadResource("/mcp", uri, { fetch, maxDecodedBytes: 0 }),
  ).rejects.toThrow("resource unavailable");
  try {
    await mcpReadResource("/mcp", uri, {
      maxDecodedBytes: 0,
      fetch: async () =>
        new Response("no", {
          status: 401,
          headers: { "www-authenticate": "Bearer" },
        }),
    });
    throw new Error("expected authentication error");
  } catch (error) {
    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({ status: 401, wwwAuthenticate: "Bearer" });
  }
});

for (const sse of [false, true]) {
  for (const kind of ["text", "blob", "metadata"] as const) {
    test(`incremental ${kind} overflow cancels before EOF (SSE=${sse})`, async () => {
      let consumed = 0;
      let eof = false;
      let cancelled = false;
      const fetch: FetchLike = async (_url, init) => {
        const { id } = JSON.parse(String(init?.body)) as { id: number };
        const large = "x".repeat(200 * 1024);
        const result =
          kind === "metadata"
            ? { _meta: { large }, contents: [{ uri, text: "" }] }
            : {
                contents: [
                  { uri, [kind]: kind === "blob" ? btoa(large) : large },
                ],
              };
        const json = JSON.stringify({ jsonrpc: "2.0", id, result });
        const wire = new TextEncoder().encode(sse ? `data: ${json}\n\n` : json);
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
          {
            headers: {
              "content-type": sse ? "text/event-stream" : "application/json",
            },
          },
        );
      };
      await expect(
        mcpReadResource("/mcp", uri, { fetch, maxDecodedBytes: 63 }),
      ).rejects.toThrow(/limit|budget/);
      expect(cancelled).toBe(true);
      expect(eof).toBe(false);
      expect(consumed).toBeLessThan(kind === "metadata" ? 68 * 1024 : 4 * 1024);
    });
  }
}
test("escaped protocol keys and aggregate resource bytes cannot evade limits", async () => {
  const fetch: FetchLike = async (_url, init) => {
    const { id } = JSON.parse(String(init?.body)) as { id: number };
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          contents: [
            { uri, text: "ab" },
            { uri, text: "cd" },
          ],
        },
      }).replace('"text"', '"te\\u0078t"'),
    );
  };
  await expect(
    mcpReadResource("/mcp", uri, { fetch, maxDecodedBytes: 3 }),
  ).rejects.toThrow("decoded byte limit");
});

test("invalid decoded limits fail before mediated fetch", async () => {
  let calls = 0;
  for (const maxDecodedBytes of [-1, 0.5, Infinity, NaN]) {
    await expect(
      mcpReadResource("/mcp", uri, {
        maxDecodedBytes,
        fetch: async () => {
          calls++;
          return Response.json({});
        },
      }),
    ).rejects.toThrow("nonnegative safe integer");
  }
  expect(calls).toBe(0);
});

test("bounded wire allowance includes fully JSON-escaped base64", () => {
  const size = 128 * 1024;
  const blob = Buffer.alloc(size).toString("base64");
  const wire = JSON.stringify({ result: { contents: [{ blob }] } }).replace(
    /[A=]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  const budget = createResourceBudget(size, false);
  expect(() => budget.push(new TextEncoder().encode(wire))).not.toThrow();
});

test("large declared budgets do not enlarge the metadata allowance", () => {
  const budget = createResourceBudget(16 * 1024 * 1024, false);
  expect(() =>
    budget.push(
      new TextEncoder().encode(
        JSON.stringify({
          result: { _meta: { large: "x".repeat(65 * 1024) }, contents: [] },
        }),
      ),
    ),
  ).toThrow(/metadata|envelope/);
});

test("decoded hard maximum applies even to oversized explicit budgets", () => {
  const budget = createResourceBudget(Number.MAX_SAFE_INTEGER, false);
  budget.push(new TextEncoder().encode('{"result":{"contents":[{"text":"'));
  const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
  for (let i = 0; i < 256; i++) budget.push(chunk);
  expect(() => budget.push(new TextEncoder().encode("x"))).toThrow(
    "decoded byte limit",
  );
});

for (const sse of [false, true]) {
  test(`large bounded read cancels oversized metadata (SSE=${sse})`, async () => {
    let consumed = 0;
    let cancelled = false;
    let eof = false;
    await expect(
      mcpReadResource("/mcp", uri, {
        maxDecodedBytes: 16 * 1024 * 1024,
        fetch: async (_url, init) => {
          const { id } = JSON.parse(String(init?.body)) as { id: number };
          const json = JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              contents: [{ uri, text: "" }],
              _meta: { large: "x".repeat(200 * 1024) },
            },
          });
          const wire = new TextEncoder().encode(
            sse ? `data: ${json}\n\n` : json,
          );
          return new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (consumed === wire.length) {
                  eof = true;
                  controller.close();
                  return;
                }
                const end = Math.min(consumed + 1024, wire.length);
                controller.enqueue(wire.subarray(consumed, end));
                consumed = end;
              },
              cancel() {
                cancelled = true;
              },
            }),
            {
              headers: {
                "content-type": sse ? "text/event-stream" : "application/json",
              },
            },
          );
        },
      }),
    ).rejects.toThrow("metadata/envelope byte limit");
    expect(cancelled).toBe(true);
    expect(eof).toBe(false);
    expect(consumed).toBeLessThan(68 * 1024);
  });
}
