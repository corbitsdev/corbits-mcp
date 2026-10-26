import { expect, test } from "bun:test";
import {
  mcpCallTool,
  MCP_EXT_TASKS,
  MCP_PROTOCOL_VERSION,
  McpError,
} from "../client.js";
import {
  validateJsonRpcRequest,
  validateUiToolMeta,
  validateContentBlock,
  validateResult,
} from "../protocol/index.js";
import type { FetchLike } from "../protocol/types.js";

test("shared envelope rejects batches, null IDs, response/request mixtures and invalid params", () => {
  const good = {
    jsonrpc: "2.0" as const,
    id: "r",
    method: "tools/list",
    params: {},
  };
  expect(validateJsonRpcRequest(good)).toEqual(good);
  for (const value of [
    [good],
    { ...good, id: null },
    { ...good, params: [] },
    { ...good, params: ["positional"] },
    { ...good, params: null },
    { ...good, result: {} },
    { ...good, jsonrpc: "1.0" },
  ])
    expect(() => validateJsonRpcRequest(value)).toThrow(McpError);
  expect(() =>
    validateJsonRpcRequest({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
    }),
  ).toThrow(McpError);
  expect(
    validateJsonRpcRequest(
      { jsonrpc: "2.0", method: "notifications/cancelled" },
      true,
    ),
  ).toHaveProperty("method", "notifications/cancelled");
});
test("shared UI visibility parser preserves metadata and rejects invented visibility", () => {
  const metadata = {
    resourceUri: "ui://test",
    visibility: ["app" as const],
    vendor: { key: true },
  };
  expect(validateUiToolMeta(metadata)).toBe(metadata);
  expect(() => validateUiToolMeta({ visibility: ["everyone"] })).toThrow(
    McpError,
  );
  expect(() =>
    validateUiToolMeta({ resourceUri: "https://example.test" }),
  ).toThrow(McpError);
});
test("modern content is strict even when resultType is omitted", async () => {
  for (const content of [
    "old nonstandard text",
    [{ type: "text" }],
    [{ type: "invented", text: "x" }],
  ]) {
    const fetch: FetchLike = async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { id: number };
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: { content },
      });
    };
    await expect(
      mcpCallTool("https://example.test/mcp", "tool", {}, { fetch }),
    ).rejects.toBeInstanceOf(McpError);
  }
  expect(
    validateResult("tools/call", {
      content: [{ type: "text", text: "valid" }],
    }),
  ).toHaveProperty("content");
  expect(() =>
    validateResult("prompts/get", { messages: [{ role: "user" }] }),
  ).toThrow(McpError);
});
test("binary and embedded resource content remain lossless", () => {
  const blocks = [
    { type: "image" as const, data: "aGk=", mimeType: "image/png" },
    { type: "audio" as const, data: "aGk=", mimeType: "audio/wav" },
    {
      type: "resource" as const,
      resource: {
        uri: "test://bytes",
        blob: "aGk=",
        mimeType: "application/octet-stream",
      },
    },
    {
      type: "resource_link" as const,
      name: "file",
      uri: "test://file",
      _meta: { "example/key": true },
    },
  ];
  for (const block of blocks) expect(validateContentBlock(block)).toBe(block);
});
test("elicitation capability option advertises only configured modes without dropping extensions", async () => {
  const fetch: FetchLike = async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as {
      id: number;
      params: { _meta: Record<string, unknown> };
    };
    expect(
      request.params._meta["io.modelcontextprotocol/protocolVersion"],
    ).toBe(MCP_PROTOCOL_VERSION);
    expect(
      request.params._meta["io.modelcontextprotocol/clientCapabilities"],
    ).toEqual({
      elicitation: { form: {} },
      extensions: { [MCP_EXT_TASKS]: {} },
    });
    return Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result: { content: [] },
    });
  };
  await mcpCallTool(
    "https://example.test/mcp",
    "tool",
    {},
    {
      fetch,
      elicitation: { form: true, url: false },
      extensions: [MCP_EXT_TASKS],
    },
  );
});
