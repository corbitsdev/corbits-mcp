// MCP streamable-HTTP transport client (2025-03-26 spec): no session id or
// resumption because this client only ever sends one request and awaits
// its one reply, which is all initialize/tools-list/tools-call need.

import type { FetchLike } from "@intx/harness";
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

export interface McpClientOptions {
  /** Injectable `fetch` for tests and mediated-credential handles. */
  fetch?: FetchLike;
  /** Abort the request, including reading its body, after this long. */
  timeoutMs?: number;
  /** Abort the request when this fires, e.g. a cancelled tool call. */
  signal?: AbortSignal;
}

/** The run-time `tools/call` and `initialize` bound when a caller sets none. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Largest response body or SSE frame read before the stream is cancelled. */
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

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
  const timeout =
    opts.timeoutMs === undefined
      ? undefined
      : AbortSignal.timeout(opts.timeoutMs);
  const signals = [timeout, opts.signal].filter((s) => s !== undefined);
  const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;
  let message: unknown;
  try {
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
      ...(signal !== undefined ? { signal } : {}),
    });

    if (!response.ok) {
      await response.body?.cancel();
      throw new McpError(
        `MCP server ${url} responded ${response.status} to ${method}`,
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    message = contentType.includes("text/event-stream")
      ? await readSseJsonRpc(response, id, signal)
      : parseJson(await readCapped(response, signal));
  } catch (cause) {
    if (opts.signal?.aborted === true) {
      throw new McpError(`${method} to MCP server ${url} was cancelled`);
    }
    if (timeout?.aborted === true) {
      throw new McpError(
        `MCP server ${url} did not answer ${method} within ${String(opts.timeoutMs)}ms`,
      );
    }
    throw cause;
  }

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

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new McpError("MCP server sent a body that is not JSON");
  }
}

function overflow(): McpError {
  return new McpError(
    `MCP server sent a message larger than ${String(MAX_MESSAGE_BYTES)} bytes`,
  );
}

/** Read a body's chunks, cancelling the stream when the signal aborts. */
async function* chunks(
  response: Response,
  signal: AbortSignal | undefined,
): AsyncGenerator<Uint8Array> {
  const body = response.body;
  if (body === null) {
    throw new McpError("MCP server sent a response with no body");
  }
  const reader = body.getReader();
  const abort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
  }
}

async function readCapped(
  response: Response,
  signal: AbortSignal | undefined,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for await (const chunk of chunks(response, signal)) {
    bytes += chunk.byteLength;
    if (bytes > MAX_MESSAGE_BYTES) throw overflow();
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

/** Read an SSE body and return the first JSON-RPC message whose id matches. */
async function readSseJsonRpc(
  response: Response,
  id: number,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of chunks(response, signal)) {
    buffer += decoder.decode(chunk, { stream: true });
    const frames = buffer.split(/\r\n\r\n|\n\n|\r\r/);
    buffer = frames.pop() ?? "";
    if (buffer.length > MAX_MESSAGE_BYTES) throw overflow();
    for (const frame of frames) {
      if (frame.length > MAX_MESSAGE_BYTES) throw overflow();
      const dataLines = frame
        .split(/\r\n|\r|\n/)
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
      clientInfo: { name: "@corbits/mcp", version: "0.2.0" },
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
