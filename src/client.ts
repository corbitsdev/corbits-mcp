// MCP streamable-HTTP transport client (2025-03-26 spec): no session id or
// resumption because this client only ever sends one request and awaits
// its one reply, which is all initialize/tools-list/tools-call need.

import { type } from "arktype";

export const McpToolSchema = type({
  name: "string",
  "description?": "string",
  inputSchema: "Record<string, unknown>",
  "annotations?": {
    "readOnlyHint?": "boolean",
    "destructiveHint?": "boolean",
    "idempotentHint?": "boolean",
    "openWorldHint?": "boolean",
  },
});
export type McpTool = typeof McpToolSchema.infer;

export interface McpToolResult {
  content: unknown;
  isError?: boolean;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface McpClientOptions {
  /** Injectable `fetch` for tests and mediated-credential handles. */
  fetch?: FetchLike;
}

const JsonRpcResponse = type({
  jsonrpc: "'2.0'",
  id: "string | number",
  "result?": "unknown",
  "error?": { code: "number", message: "string", "data?": "unknown" },
});

export class McpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpError";
  }
}

let nextId = 1;

/**
 * Send one JSON-RPC request over streamable HTTP and return its `result`.
 * Handles both response shapes the spec allows: a direct `application/json`
 * body, and a `text/event-stream` whose `data:` frames each carry a
 * JSON-RPC message -- the first one matching this request's id wins.
 */
async function sendRequest(
  url: string,
  method: string,
  params: Record<string, unknown> | undefined,
  opts: McpClientOptions,
): Promise<unknown> {
  const fetchImpl = opts.fetch ?? fetch;
  const id = nextId++;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    }),
  });

  if (!response.ok) {
    throw new McpError(
      `MCP server ${url} responded ${response.status} to ${method}`,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  const message = contentType.includes("text/event-stream")
    ? await readSseJsonRpc(response, id)
    : await response.json();

  const parsed = JsonRpcResponse(message);
  if (parsed instanceof type.errors) {
    throw new McpError(
      `MCP server ${url} sent a malformed response to ${method}: ${parsed.summary}`,
    );
  }
  if (parsed.error !== undefined) {
    throw new McpError(
      `MCP server ${url} rejected ${method}: ${parsed.error.message}`,
    );
  }
  return parsed.result;
}

/** Read an SSE body and return the first JSON-RPC message whose id matches. */
async function readSseJsonRpc(
  response: Response,
  id: number,
): Promise<unknown> {
  const body = response.body;
  if (body === null) {
    throw new McpError("MCP server sent an event-stream response with no body");
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const dataLines = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim());
        if (dataLines.length === 0) continue;
        const candidate: unknown = JSON.parse(dataLines.join("\n"));
        if (
          typeof candidate === "object" &&
          candidate !== null &&
          "id" in candidate &&
          (candidate as { id: unknown }).id === id
        ) {
          return candidate;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  throw new McpError(
    "MCP server closed the event stream without a matching response",
  );
}

const InitializeResult = type({
  "protocolVersion?": "string",
  "serverInfo?": { name: "string", "version?": "string" },
});
export type McpServerInfo = typeof InitializeResult.infer;

/** `initialize` handshake. The server's own identification is returned for a
 * caller that shows it; nothing here depends on it. */
export async function mcpInitialize(
  url: string,
  opts: McpClientOptions = {},
): Promise<McpServerInfo> {
  const result = await sendRequest(
    url,
    "initialize",
    {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "@corbits/mcp", version: "0.1.0" },
    },
    opts,
  );
  const parsed = InitializeResult(result);
  return parsed instanceof type.errors ? {} : parsed;
}

const ToolsListResult = type({ tools: McpToolSchema.array() });

/** `tools/list`: the remote server's tool catalog. */
export async function mcpListTools(
  url: string,
  opts: McpClientOptions = {},
): Promise<McpTool[]> {
  const result = await sendRequest(url, "tools/list", undefined, opts);
  const parsed = ToolsListResult(result);
  if (parsed instanceof type.errors) {
    throw new McpError(
      `MCP server ${url} sent a malformed tools/list result: ${parsed.summary}`,
    );
  }
  return parsed.tools;
}

/** `tools/call`: invoke a remote tool by name with JSON arguments. */
const ToolCallResult = type({
  content: "unknown",
  "isError?": "boolean",
});

export async function mcpCallTool(
  url: string,
  name: string,
  toolArguments: Record<string, unknown>,
  opts: McpClientOptions = {},
): Promise<McpToolResult> {
  const result = await sendRequest(
    url,
    "tools/call",
    { name, arguments: toolArguments },
    opts,
  );
  const parsed = ToolCallResult(result);
  if (parsed instanceof type.errors) {
    throw new McpError(
      `MCP server ${url} sent a malformed tools/call result for ${name}: ${parsed.summary}`,
    );
  }
  return parsed;
}
