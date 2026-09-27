// MCP streamable-HTTP transport client (2025-03-26 spec). Each call sends one
// request and awaits its one reply, which is all initialize/tools-list/
// tools-call need; the session `initialize` opens is carried in `session`.
// No resumption.

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
  /** The session `mcpInitialize` opened; required by stateful servers. */
  session?: McpSession;
}

/** The run-time `tools/call` and `initialize` bound when a caller sets none. */
export const DEFAULT_TIMEOUT_MS = 60_000;

const PROTOCOL_VERSION = "2025-03-26";

/** Largest response body or SSE frame read before the stream is cancelled. */
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

const JsonRpcResponse = type({
  jsonrpc: "'2.0'",
  id: "string | number",
  "result?": "unknown",
  "error?": { code: "number", message: "string", "data?": "unknown" },
});

export class McpError extends Error {
  /** The HTTP status, when the server answered with a non-2xx one. */
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "McpError";
    this.status = status;
  }
}

let nextId = 1;

/** A reply to request `id`: a message carrying `result` or `error` and no
 * `method`, which would make it a server request reusing the id. */
function isResponseTo(message: unknown, id: number): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { id?: unknown }).id === id &&
    !("method" in message) &&
    ("result" in message || "error" in message)
  );
}

function headersFor(session: McpSession | undefined): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(session === undefined
      ? {}
      : { "mcp-protocol-version": session.protocolVersion }),
    ...(session?.sessionId === undefined
      ? {}
      : { "mcp-session-id": session.sessionId }),
  };
}

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
): Promise<{ result: unknown; sessionId: string | undefined }> {
  const fetchImpl = opts.fetch ?? fetch;
  const id = nextId++;
  const timeout =
    opts.timeoutMs === undefined
      ? undefined
      : AbortSignal.timeout(opts.timeoutMs);
  const signals = [timeout, opts.signal].filter((s) => s !== undefined);
  const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;
  let message: unknown;
  let sessionId: string | undefined;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: headersFor(opts.session),
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
        response.status,
      );
    }

    sessionId = response.headers.get("mcp-session-id") ?? undefined;
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
  if (parsed instanceof type.errors || !isResponseTo(message, id)) {
    throw new McpError(
      `MCP server ${url} sent a malformed response to ${method}${parsed instanceof type.errors ? `: ${parsed.summary}` : ""}`,
    );
  }
  if (parsed.error !== undefined) {
    throw new McpError(
      `MCP server ${url} rejected ${method}: ${parsed.error.message}`,
    );
  }
  return { result: parsed.result, sessionId };
}

/** Send a JSON-RPC notification; the server answers 202 with no body. */
async function sendNotification(
  url: string,
  method: string,
  opts: McpClientOptions,
): Promise<void> {
  const fetchImpl = opts.fetch ?? fetch;
  const timeout =
    opts.timeoutMs === undefined
      ? undefined
      : AbortSignal.timeout(opts.timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: headersFor(opts.session),
      body: JSON.stringify({ jsonrpc: "2.0", method }),
      ...(timeout !== undefined ? { signal: timeout } : {}),
    });
  } catch (cause) {
    if (timeout?.aborted === true) {
      throw new McpError(
        `MCP server ${url} did not answer ${method} within ${String(opts.timeoutMs)}ms`,
      );
    }
    throw cause;
  }
  await response.body?.cancel();
  if (!response.ok) {
    throw new McpError(
      `MCP server ${url} responded ${response.status} to ${method}`,
      response.status,
    );
  }
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
      let candidate: unknown;
      try {
        candidate = JSON.parse(dataLines.join("\n"));
      } catch {
        continue;
      }
      if (isResponseTo(candidate, id)) return candidate;
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

export type McpSession = {
  /** The negotiated version, sent as `MCP-Protocol-Version`. */
  readonly protocolVersion: string;
  /** The `Mcp-Session-Id` a stateful server assigned, if any. */
  readonly sessionId?: string;
  /** The server's own identification, for a caller that shows it. */
  readonly serverInfo?: NonNullable<McpServerInfo["serverInfo"]>;
};

/** `initialize` handshake followed by `notifications/initialized`. Pass the
 * returned session to every later call on this server. */
export async function mcpInitialize(
  url: string,
  opts: McpClientOptions = {},
): Promise<McpSession> {
  const { result, sessionId } = await sendRequest(
    url,
    "initialize",
    {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "@corbits/mcp", version: "0.2.0" },
    },
    {
      ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    },
  );
  const parsed = InitializeResult(result);
  const info = parsed instanceof type.errors ? {} : parsed;
  // Echoed into the MCP-Protocol-Version header, so printable ASCII only.
  if (
    info.protocolVersion !== undefined &&
    !/^[\x20-\x7e]+$/.test(info.protocolVersion)
  ) {
    throw new McpError(
      `MCP server ${url} sent a protocolVersion that is not printable ASCII`,
    );
  }
  const session: McpSession = {
    protocolVersion: info.protocolVersion ?? PROTOCOL_VERSION,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(info.serverInfo !== undefined ? { serverInfo: info.serverInfo } : {}),
  };
  await sendNotification(url, "notifications/initialized", {
    ...opts,
    session,
  });
  return session;
}

const ToolsListResult = type({ tools: McpToolSchema.array() });

/** `tools/list`: the remote server's tool catalog. */
export async function mcpListTools(
  url: string,
  opts: McpClientOptions = {},
): Promise<McpTool[]> {
  const { result } = await sendRequest(url, "tools/list", undefined, opts);
  const parsed = ToolsListResult(result);
  if (parsed instanceof type.errors) {
    throw new McpError(
      `MCP server ${url} sent a malformed tools/list result: ${parsed.summary}`,
    );
  }
  const names = new Set(parsed.tools.map((tool) => tool.name));
  if (names.size !== parsed.tools.length) {
    throw new McpError(
      `MCP server ${url} sent a tools/list result with duplicate tool names`,
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
  const { result } = await sendRequest(
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
