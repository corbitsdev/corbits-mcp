// Streamable-HTTP JSON-RPC client for MCP 2026-07-28, with a legacy
// fallback. A 2026 server is stateless: `server/discover` then one POST per
// call, carrying protocol metadata in `_meta` and in `Mcp-*` headers, and no
// session id. Modern cancellation closes the response stream; only legacy
// requests send `notifications/cancelled`. No SSE resumption or HTTP+SSE.

import { type } from "arktype";
import {
  createResourceBudget,
  type ResourceBudget,
} from "./client/resource-budget.js";
import {
  MCP_PROTOCOL_VERSION,
  type FetchLike,
  type McpValidationContext,
  type TaskStatus,
  type McpSubscriptionFilter,
} from "./protocol/types.js";
import { McpError, McpErrorCode } from "./protocol/errors.js";
import {
  MCP_EXT_TASKS,
  MCP_EXT_UI,
  MCP_EXT_SKILLS,
  validateExtensionSettings,
} from "./protocol/extensions.js";
import {
  McpToolSchema,
  type McpTool,
  PromptSchema,
  PromptResult,
  ResourceSchema,
  TemplateSchema,
  CompletionResult,
  SkillSchema,
  TaskHandleSchema,
  ToolCallResult,
  DiscoverResult,
  JsonRpcResponse,
  validateRequest,
  validateResult,
  validateNotification,
  validateTask,
  record,
  validateProgressToken,
} from "./protocol/schemas.js";
import {
  encodeHeaderValue,
  paramHeaders,
  collectHeaderSlots,
} from "./protocol/headers.js";
import { mcpNameFor } from "./protocol/methods.js";
import type { McpRequestTransport } from "./client/transport.js";
export {
  MCP_PROTOCOL_VERSION,
  McpError,
  McpErrorCode,
  MCP_EXT_TASKS,
  MCP_EXT_UI,
  MCP_EXT_SKILLS,
  McpToolSchema,
};
export type { McpTool, McpSubscriptionFilter };
export type {
  McpRequestTransport,
  McpRequestOptions,
} from "./client/transport.js";
const LEGACY_PROTOCOL_VERSION = "2025-03-26";
/** Legacy handshake versions, newest first. */
const LEGACY_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

const META_PROTOCOL = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const META_SUBSCRIPTION = "io.modelcontextprotocol/subscriptionId";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

const CLIENT_INFO = { name: "@corbits/mcp", version: "0.3.1" } as const;
const UI_MIME_TYPES = ["text/html;profile=mcp-app"] as const;

const MODERN_ERROR_CODES = new Set<number>([
  McpErrorCode.HeaderMismatch,
  McpErrorCode.MissingRequiredClientCapability,
  McpErrorCode.UnsupportedProtocolVersion,
]);

export type McpCacheScope = "public" | "private";

export type McpToolList = McpTool[] & {
  ttlMs?: number;
  cacheScope?: McpCacheScope;
};

export interface McpToolResult {
  /** `"complete"` on a resolved result; absent while the call awaits input
   * or runs a task. Optional so resolved results keep the previous contract. */
  resultType?: "complete";
  content: unknown;
  isError?: boolean;
  structuredContent?: unknown;
  /** Tool-result metadata, including MCP Apps `_meta.ui` when the server sent it. */
  _meta?: Record<string, unknown>;
}

export interface McpInputRequired {
  resultType: "input_required";
  /** The method to retry. */
  method: string;
  /** Original params, without `_meta`, to send again with `inputResponses`. */
  params: Record<string, unknown>;
  inputRequests?: Record<string, unknown>;
  /** Opaque server state. Echoed verbatim on retry; never inspected. */
  requestState?: string;
  _meta?: Record<string, unknown>;
}

export type McpTaskStatus = TaskStatus;

export interface McpTaskHandle {
  resultType: "task";
  taskId: string;
  status: McpTaskStatus;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs?: number;
  statusMessage?: string;
  _meta?: Record<string, unknown>;
}

export interface McpTask {
  resultType: "complete";
  taskId: string;
  status: McpTaskStatus;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs?: number;
  statusMessage?: string;
  inputRequests?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
  _meta?: Record<string, unknown>;
}

export type McpToolCallResult =
  | McpToolResult
  | McpInputRequired
  | McpTaskHandle;

export interface McpProgress {
  progressToken: string | number;
  progress: number;
  total?: number;
  message?: string;
}

export type McpClientCapabilities = Record<string, unknown>;

export interface McpClientOptions {
  /** Injectable `fetch` for tests and mediated-credential handles. */
  fetch?: FetchLike;
  /** Abort the request and body after this long (default 60s).
   * subscriptions/listen has no default deadline; set this to bound its lifetime. */
  timeoutMs?: number;
  /** Abort the request when this fires, e.g. a cancelled tool call. */
  signal?: AbortSignal;
  /** The session `mcpConnect` or `mcpInitialize` opened. */
  session?: McpSession;
  /**
   * Extension ids to advertise in `clientCapabilities.extensions`.
   * Unlisted extensions are not advertised and their methods are not sent.
   */
  extensions?: readonly string[];
  /** MIME types advertised for `io.modelcontextprotocol/ui`. */
  uiMimeTypes?: readonly string[];
  /** Receives `notifications/progress` from this call's response stream. */
  onProgress?: (progress: McpProgress) => void;
  /** Progress token. Defaults to the request id when `onProgress` is set. */
  progressToken?: string | number;
  /** Tool `inputSchema`, so `x-mcp-header` parameters are mirrored into headers. */
  inputSchema?: Record<string, unknown>;
  /** Validate successful structured tool output when its catalog schema is known. */
  outputSchema?: Record<string, unknown>;
  /** resources/read only: bound aggregate decoded text/blob bytes while streaming.
   * Capped at 16 MiB decoded, with bounded JSON/base64 encoding overhead and
   * a separate 64 KiB envelope cap. Unbounded reads retain the 4 MiB default. */
  maxDecodedBytes?: number;
  /** Optional host capabilities; never inferred from installed code. */
  clientCapabilities?: McpClientCapabilities;
  /** Advertise only modes for which the caller has configured user-facing host services. */
  elicitation?: { form?: boolean; url?: boolean };
  validation?: McpValidationContext;
}

/** The run-time `tools/call` and `initialize` bound when a caller sets none. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Largest response body or SSE frame read before the stream is cancelled. */
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

/** A cursor loop that never ends is a misbehaving server, not a catalog. */
const MAX_PAGES = 1_000;

let nextId = 1;
const activeProgressTokens = new Set<string | number>();
function reserveProgressToken(token: string | number | undefined): void {
  if (token === undefined) return;
  if (activeProgressTokens.has(token))
    throw new McpError("progress token is already active");
  activeProgressTokens.add(token);
}

function validationContext(opts: McpClientOptions): McpValidationContext {
  return {
    ...opts.validation,
    era:
      opts.session !== undefined && !isModernSession(opts.session)
        ? "legacy"
        : "modern",
    extensions: enabledExtensions(opts),
    ...(opts.session?.capabilities !== undefined
      ? { serverCapabilities: opts.session.capabilities }
      : {}),
    ...(opts.inputSchema !== undefined
      ? { inputSchema: opts.inputSchema }
      : {}),
    ...(opts.outputSchema !== undefined
      ? { outputSchema: opts.outputSchema }
      : {}),
    clientCapabilities: clientCapabilities(opts),
  };
}

export function createMcpRequestTransport(
  url: string,
  defaults: McpClientOptions = {},
): McpRequestTransport {
  return {
    async request(method, params, options = {}) {
      const opts = { ...defaults, ...options };
      const callOpts = opts.session === undefined ? asModern(opts) : opts;
      const { result } = await sendRequest(url, method, params, callOpts);
      return result as Record<string, unknown>;
    },
    listen(filter, observer, options = {}) {
      return mcpListen(url, filter, observer, { ...defaults, ...options });
    },
  };
}

function isModernSession(session: McpSession | undefined): boolean {
  return session?.protocolVersion === MCP_PROTOCOL_VERSION;
}

function enabledExtensions(opts: McpClientOptions): readonly string[] {
  if (opts.extensions !== undefined) return opts.extensions;
  return opts.session?.extensions ?? [];
}

function requireExtension(opts: McpClientOptions, id: string): void {
  if (!enabledExtensions(opts).includes(id)) {
    throw new McpError(`extension ${id} is not enabled`);
  }
}

function clientCapabilities(opts: McpClientOptions): McpClientCapabilities {
  if (opts.elicitation !== undefined) {
    const { elicitation, ...base } = opts;
    const capabilities = clientCapabilities(base);
    const modes = {
      ...(elicitation.form === true ? { form: {} } : {}),
      ...(elicitation.url === true ? { url: {} } : {}),
    };
    const { elicitation: _inherited, ...rest } = capabilities;
    return {
      ...rest,
      ...(Object.keys(modes).length > 0 ? { elicitation: modes } : {}),
    };
  }
  if (
    opts.clientCapabilities === undefined &&
    opts.extensions === undefined &&
    opts.uiMimeTypes === undefined &&
    opts.session?.clientCapabilities !== undefined
  ) {
    return opts.session.clientCapabilities;
  }
  const extensions = enabledExtensions(opts);
  validateExtensionSettings(
    Object.fromEntries(extensions.map((id) => [id, {}])),
  );
  if (extensions.length === 0) return opts.clientCapabilities ?? {};
  const advertised: Record<string, unknown> = {};
  for (const id of extensions) {
    if (id === MCP_EXT_UI) {
      const mimeTypes = opts.uiMimeTypes ?? opts.session?.uiMimeTypes;
      advertised[id] = {
        mimeTypes: [...(mimeTypes ?? UI_MIME_TYPES)],
      };
    } else {
      advertised[id] = {};
    }
  }
  return { ...opts.clientCapabilities, extensions: advertised };
}

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

function isNotification(
  message: unknown,
): message is { method: string; params?: Record<string, unknown> } {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { jsonrpc?: unknown }).jsonrpc === "2.0" &&
    typeof (message as { method?: unknown }).method === "string" &&
    !("id" in message)
  );
}

function collectHeaders(schema: Record<string, unknown>, toolName: string) {
  try {
    return collectHeaderSlots(schema);
  } catch (cause) {
    console.warn(
      `excluding MCP tool ${toolName}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return undefined;
  }
}
function requestHeaders(
  opts: McpClientOptions,
  method: string,
  mcpName: string | undefined,
  extra: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (isModernSession(opts.session)) {
    headers["MCP-Protocol-Version"] = MCP_PROTOCOL_VERSION;
    headers["Mcp-Method"] = method;
    if (mcpName !== undefined) headers["Mcp-Name"] = encodeHeaderValue(mcpName);
    for (const [key, value] of Object.entries(extra)) headers[key] = value;
    return headers;
  }
  if (opts.session !== undefined) {
    headers["mcp-protocol-version"] = opts.session.protocolVersion;
    if (opts.session.sessionId !== undefined) {
      headers["mcp-session-id"] = opts.session.sessionId;
    }
  }
  return headers;
}

function progressParams(
  params: Record<string, unknown> | undefined,
  opts: McpClientOptions,
  id: number,
): Record<string, unknown> {
  const metadata =
    params?._meta === undefined ? {} : record(params._meta, "request _meta");
  const token =
    opts.progressToken !== undefined
      ? opts.progressToken
      : (metadata.progressToken ??
        (opts.onProgress !== undefined ? id : undefined));
  if (Object.hasOwn(metadata, "progressToken"))
    validateProgressToken(metadata.progressToken);
  if (token !== undefined) validateProgressToken(token);
  return {
    ...params,
    _meta: {
      ...metadata,
      ...(token !== undefined ? { progressToken: token } : {}),
    },
  };
}

function modernParams(
  params: Record<string, unknown> | undefined,
  opts: McpClientOptions,
  id: number,
): Record<string, unknown> {
  const base = progressParams(params, opts, id);
  return {
    ...base,
    _meta: {
      ...record(base._meta),
      [META_PROTOCOL]: MCP_PROTOCOL_VERSION,
      [META_CLIENT_INFO]: CLIENT_INFO,
      [META_CLIENT_CAPABILITIES]: clientCapabilities(opts),
    },
  };
}

function stripMeta(
  params: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (params === undefined) return {};
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key !== "_meta") rest[key] = value;
  }
  return rest;
}

/** A fresh request. The aborted call signal must not cancel this notification,
 * and progress fields belong to the call that was cancelled. */
function cancellationOpts(opts: McpClientOptions): McpClientOptions {
  return {
    ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.session !== undefined ? { session: opts.session } : {}),
    ...(opts.extensions !== undefined ? { extensions: opts.extensions } : {}),
    ...(opts.uiMimeTypes !== undefined
      ? { uiMimeTypes: opts.uiMimeTypes }
      : {}),
  };
}

function deliverProgress(
  message: unknown,
  token: string | number | undefined,
  onProgress: ((progress: McpProgress) => void) | undefined,
  previous: number | undefined,
): number | undefined {
  if (token === undefined || !isNotification(message)) {
    return previous;
  }
  if (message.method !== "notifications/progress") return previous;
  const params = message.params;
  if (params === undefined || params.progressToken !== token) return previous;
  validateNotification("notifications/progress", params);
  if (typeof params.progress !== "number") return previous;
  const progress: McpProgress = {
    progressToken: token,
    progress: params.progress,
  };
  if (typeof params.total === "number") progress.total = params.total;
  if (typeof params.message === "string") progress.message = params.message;
  if (previous !== undefined && progress.progress <= previous)
    throw new McpError("progress must strictly increase");
  onProgress?.(progress);
  return progress.progress;
}

/**
 * Send one JSON-RPC request over streamable HTTP and return its `result`.
 * Handles both response shapes the spec allows: a direct `application/json`
 * body, and a `text/event-stream` whose `data:` frames each carry a
 * JSON-RPC message -- the first one matching this request's id wins.
 * Progress notifications on that stream are delivered and not treated as the
 * response.
 */
async function sendRequest(
  url: string,
  method: string,
  params: Record<string, unknown> | undefined,
  opts: McpClientOptions,
): Promise<{ result: unknown; sessionId: string | undefined }> {
  if (
    method === "resources/read" &&
    opts.maxDecodedBytes !== undefined &&
    (!Number.isSafeInteger(opts.maxDecodedBytes) || opts.maxDecodedBytes < 0)
  )
    throw new McpError("maxDecodedBytes must be a nonnegative safe integer");
  const fetchImpl = opts.fetch ?? fetch;
  const id = nextId++;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signals = [timeout, opts.signal].filter((s) => s !== undefined);
  const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;
  const modern = isModernSession(opts.session);
  const bodyParams = modern
    ? modernParams(params, opts, id)
    : progressParams(params, opts, id);
  if (method !== "initialize")
    validateRequest(method, bodyParams, validationContext(opts));
  const progressToken = record(bodyParams._meta).progressToken as
    | string
    | number
    | undefined;
  let previousProgress: number | undefined;
  const extra =
    method === "tools/call"
      ? paramHeaders(
          opts.inputSchema,
          params?.arguments,
          String(params?.name ?? ""),
        )
      : {};
  let message: unknown;
  let sessionId: string | undefined;
  const notifyCancel = () => {
    void sendNotification(
      url,
      "notifications/cancelled",
      cancellationOpts(opts),
      {
        requestId: id,
        reason: "the caller aborted the request",
      },
    ).catch(() => undefined);
  };
  reserveProgressToken(progressToken);
  if (!modern && method !== "initialize" && opts.signal !== undefined) {
    opts.signal.addEventListener("abort", notifyCancel, { once: true });
  }
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: requestHeaders(opts, method, mcpNameFor(method, params), extra),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        ...(bodyParams !== undefined ? { params: bodyParams } : {}),
      }),
      ...(signal !== undefined ? { signal } : {}),
    });

    if (!response.ok) {
      throw await errorFrom(response, url, method, signal);
    }

    sessionId = response.headers.get("mcp-session-id") ?? undefined;
    const contentType = response.headers.get("content-type") ?? "";
    const budget =
      method === "resources/read" && opts.maxDecodedBytes !== undefined
        ? createResourceBudget(
            opts.maxDecodedBytes,
            contentType.includes("text/event-stream"),
          )
        : undefined;
    message = contentType.includes("text/event-stream")
      ? await readSseJsonRpc(
          response,
          id,
          signal,
          (frame) => {
            previousProgress = deliverProgress(
              frame,
              progressToken,
              opts.onProgress,
              previousProgress,
            );
          },
          budget,
        )
      : parseJson(await readCapped(response, signal, budget));
  } catch (cause) {
    if (opts.signal?.aborted === true) {
      throw new McpError(
        `${method} to MCP server ${url} was cancelled`,
        undefined,
        undefined,
        undefined,
        {
          cancelled: true,
        },
      );
    }
    if (timeout?.aborted === true) {
      throw new McpError(
        `MCP server ${url} did not answer ${method} within ${String(timeoutMs)}ms`,
        undefined,
        undefined,
        undefined,
        { timedOut: true },
      );
    }
    throw cause;
  } finally {
    opts.signal?.removeEventListener("abort", notifyCancel);
    if (progressToken !== undefined) activeProgressTokens.delete(progressToken);
  }

  const parsed = JsonRpcResponse(message);
  if (
    parsed instanceof type.errors ||
    !isResponseTo(message, id) ||
    (parsed.error !== undefined && Object.hasOwn(parsed, "result"))
  ) {
    throw new McpError(
      `MCP server ${url} sent a malformed response to ${method}`,
    );
  }
  if (parsed.error !== undefined) {
    throw new McpError(
      `MCP server ${url} rejected ${method}: ${parsed.error.message}`,
      undefined,
      parsed.error.code,
      parsed.error.data,
      { source: "peer" },
    );
  }
  if (method !== "initialize")
    validateResult(method, parsed.result, {
      ...validationContext(opts),
      // Never accept a caller-supplied validation context as proof of a wire budget.
      maxDecodedBytes:
        method === "resources/read" ? opts.maxDecodedBytes : undefined,
    });
  return { result: parsed.result, sessionId };
}

/** Send a JSON-RPC notification; the server answers 202 with no body. */
async function sendNotification(
  url: string,
  method: string,
  opts: McpClientOptions,
  params?: Record<string, unknown>,
): Promise<void> {
  const fetchImpl = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const modern = isModernSession(opts.session);
  const bodyParams =
    params === undefined
      ? undefined
      : modern
        ? modernParams(params, cancellationOpts(opts), 0)
        : params;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: requestHeaders(opts, method, undefined, {}),
      body: JSON.stringify({
        jsonrpc: "2.0",
        method,
        ...(bodyParams !== undefined ? { params: bodyParams } : {}),
      }),
      ...(timeout !== undefined ? { signal: timeout } : {}),
    });
  } catch (cause) {
    if (timeout?.aborted === true) {
      throw new McpError(
        `MCP server ${url} did not answer ${method} within ${String(opts.timeoutMs)}ms`,
        undefined,
        undefined,
        undefined,
        { timedOut: true },
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

async function errorFrom(
  response: Response,
  url: string,
  method: string,
  signal: AbortSignal | undefined,
): Promise<McpError> {
  if (response.status === 401 || response.status === 403) {
    void response.body?.cancel().catch(() => undefined);
    const challenge = response.headers.get("www-authenticate");
    return new McpError(
      `MCP server ${url} responded ${response.status} to ${method}`,
      response.status,
      undefined,
      undefined,
      challenge === null ? undefined : { wwwAuthenticate: challenge },
    );
  }
  let code: number | undefined;
  let data: unknown;
  let detail: string | undefined;
  try {
    const text = await readCapped(response, signal);
    if (text.length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      if (typeof parsed === "object" && parsed !== null) {
        const error = (parsed as { error?: unknown }).error;
        if (typeof error === "object" && error !== null) {
          const record = error as {
            code?: unknown;
            message?: unknown;
            data?: unknown;
          };
          if (
            typeof record.code === "number" &&
            typeof record.message === "string"
          ) {
            code = record.code;
            detail = record.message;
            data = record.data;
          }
        }
      }
    }
  } catch (cause) {
    if (cause instanceof McpError && cause.message.includes("larger than"))
      throw cause;
  }
  const message =
    detail === undefined
      ? `MCP server ${url} responded ${response.status} to ${method}`
      : `MCP server ${url} rejected ${method}: ${detail}`;
  return new McpError(message, response.status, code, data, {
    source: code === undefined ? "local" : "peer",
  });
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
  budget?: ResourceBudget,
): AsyncGenerator<Uint8Array> {
  signal?.throwIfAborted();
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
      if (done) {
        budget?.finish();
        return;
      }
      budget?.push(value);
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
  budget?: ResourceBudget,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for await (const chunk of chunks(response, signal, budget)) {
    bytes += chunk.byteLength;
    if (budget === undefined && bytes > MAX_MESSAGE_BYTES) throw overflow();
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

async function* sseMessages(
  response: Response,
  signal: AbortSignal | undefined,
  budget?: ResourceBudget,
): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of chunks(response, signal, budget)) {
    buffer += decoder.decode(chunk, { stream: true });
    const frames = buffer.split(/\r\n\r\n|\n\n|\r\r/);
    buffer = frames.pop() ?? "";
    if (budget === undefined && buffer.length > MAX_MESSAGE_BYTES)
      throw overflow();
    for (const frame of frames) {
      if (budget === undefined && frame.length > MAX_MESSAGE_BYTES)
        throw overflow();
      const dataLines = frame
        .split(/\r\n|\r|\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());
      if (dataLines.length === 0) continue;
      try {
        yield JSON.parse(dataLines.join("\n"));
      } catch {
        // A non-JSON data frame is not the response; keep reading.
      }
    }
  }
}

/** Read an SSE body and return the first JSON-RPC message whose id matches. */
async function readSseJsonRpc(
  response: Response,
  id: number,
  signal: AbortSignal | undefined,
  onMessage: (message: unknown) => void,
  budget?: ResourceBudget,
): Promise<unknown> {
  for await (const candidate of sseMessages(response, signal, budget)) {
    if (isResponseTo(candidate, id)) return candidate;
    onMessage(candidate);
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
  /** The `Mcp-Session-Id` a stateful legacy server assigned, if any. */
  readonly sessionId?: string;
  /** The server's own identification, for a caller that shows it. */
  readonly serverInfo?: NonNullable<McpServerInfo["serverInfo"]>;
  /** Server capabilities from `server/discover`. Absent on the legacy path. */
  readonly capabilities?: Record<string, unknown>;
  /** Capabilities this client advertised for the modern session. */
  readonly clientCapabilities?: McpClientCapabilities;
  /** Extension ids opted in when the session was opened. */
  readonly extensions?: readonly string[];
  readonly uiMimeTypes?: readonly string[];
  readonly instructions?: string;
};

function serverInfoOf(
  meta: Record<string, unknown> | undefined,
): McpSession["serverInfo"] | undefined {
  const info = meta?.[META_SERVER_INFO];
  if (typeof info !== "object" || info === null) return undefined;
  const name = (info as { name?: unknown }).name;
  if (typeof name !== "string") return undefined;
  const version = (info as { version?: unknown }).version;
  return typeof version === "string" ? { name, version } : { name };
}

/** `initialize` handshake followed by `notifications/initialized`. Pass the
 * returned session to every later call on a legacy server. */
export async function mcpInitialize(
  url: string,
  opts: McpClientOptions = {},
): Promise<McpSession> {
  return initializeLegacy(url, opts, LEGACY_PROTOCOL_VERSION);
}

async function initializeLegacy(
  url: string,
  opts: McpClientOptions,
  protocolVersion: string,
): Promise<McpSession> {
  const { result, sessionId } = await sendRequest(
    url,
    "initialize",
    {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "@corbits/mcp", version: "0.3.1" },
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
    protocolVersion: info.protocolVersion ?? protocolVersion,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(info.serverInfo !== undefined ? { serverInfo: info.serverInfo } : {}),
  };
  await sendNotification(url, "notifications/initialized", {
    ...opts,
    session,
  });
  return session;
}

function supportedFrom(data: unknown): string[] {
  if (typeof data !== "object" || data === null) return [];
  const supported = (data as { supported?: unknown }).supported;
  if (!Array.isArray(supported)) return [];
  return supported.filter(
    (version): version is string => typeof version === "string",
  );
}

function legacyVersion(supported: readonly string[]): string | undefined {
  return LEGACY_VERSIONS.find((version) => supported.includes(version));
}

function shouldFallback(error: unknown): boolean {
  if (!(error instanceof McpError)) return false;
  if (
    error.status !== undefined &&
    error.status !== 400 &&
    error.status !== 404
  )
    return false;
  if (error.cancelled) return false;
  if (error.timedOut) return true;
  // Streamable HTTP backward compatibility: inspect HTTP 400 bodies before
  // falling back. Recognized modern errors require correcting the request,
  // while empty or unrecognized bodies may come from a legacy session server.
  if (error.status === 400)
    return error.code === undefined || !MODERN_ERROR_CODES.has(error.code);
  // Preserve the existing fallback rules for other transport responses.
  if (error.code === McpErrorCode.MethodNotFound) return true;
  if (error.status === 404) return true;
  if (/unsupported protocol version/i.test(error.message)) return true;
  if (/server not initialized/i.test(error.message)) return true;
  if (error.status !== undefined) return false;
  if (error.code !== undefined && MODERN_ERROR_CODES.has(error.code))
    return false;
  // Malformed responses and any other error are real failures, not legacy.
  return false;
}

/**
 * Probe `server/discover`. A 2026-07-28 server returns a stateless session:
 * later calls send no `initialize`, no `notifications/initialized`, and no
 * `Mcp-Session-Id`. A method-not-found, a timeout, or a server that only
 * speaks a 2025 (or earlier) version falls back to `initialize`. HTTP 400
 * also falls back unless its body contains a recognized modern error. Authz
 * failures, rate limits, server errors, and malformed responses are real
 * failures and surface to the caller instead of triggering the legacy
 * handshake.
 */
export async function mcpConnect(
  url: string,
  opts: McpClientOptions = {},
): Promise<McpSession> {
  const probing: McpSession = {
    protocolVersion: MCP_PROTOCOL_VERSION,
    clientCapabilities: clientCapabilities(opts),
    ...(opts.extensions !== undefined && opts.extensions.length > 0
      ? { extensions: opts.extensions }
      : {}),
    ...(opts.uiMimeTypes !== undefined
      ? { uiMimeTypes: opts.uiMimeTypes }
      : {}),
  };
  const probeOpts: McpClientOptions = { ...opts, session: probing };
  try {
    const { result } = await sendRequest(
      url,
      "server/discover",
      undefined,
      probeOpts,
    );
    const kind = resultKind(result);
    if (kind !== "complete") {
      throw new McpError(
        `MCP server ${url} sent a ${kind} result for server/discover`,
      );
    }
    const parsed = DiscoverResult(result);
    if (parsed instanceof type.errors) {
      throw new McpError(
        `MCP server ${url} sent a malformed server/discover result: ${parsed.summary}`,
      );
    }
    if (parsed.supportedVersions.includes(MCP_PROTOCOL_VERSION)) {
      const meta = parsed._meta;
      const serverInfo = serverInfoOf(meta);
      return {
        ...probing,
        ...(serverInfo !== undefined ? { serverInfo } : {}),
        capabilities: parsed.capabilities,
        ...(parsed.instructions !== undefined
          ? { instructions: parsed.instructions }
          : {}),
      };
    }
    const legacy = legacyVersion(parsed.supportedVersions);
    if (legacy !== undefined) return initializeLegacy(url, opts, legacy);
    throw new McpError(
      `MCP server ${url} does not speak ${MCP_PROTOCOL_VERSION}`,
      undefined,
      McpErrorCode.UnsupportedProtocolVersion,
      { supported: parsed.supportedVersions, requested: MCP_PROTOCOL_VERSION },
    );
  } catch (cause) {
    if (
      cause instanceof McpError &&
      cause.code === McpErrorCode.UnsupportedProtocolVersion &&
      (cause.status === undefined ||
        cause.status === 400 ||
        cause.status === 404)
    ) {
      const legacy = legacyVersion(supportedFrom(cause.data));
      if (legacy !== undefined) return initializeLegacy(url, opts, legacy);
      throw cause;
    }
    if (shouldFallback(cause))
      return initializeLegacy(url, opts, LEGACY_PROTOCOL_VERSION);
    throw cause;
  }
}

type ResultKind = "complete" | "input_required" | "task" | "invalid";

function resultKind(result: unknown): ResultKind {
  if (
    typeof result !== "object" ||
    result === null ||
    !("resultType" in result)
  ) {
    return "complete";
  }
  const value = (result as { resultType?: unknown }).resultType;
  if (value === undefined) return "complete";
  if (value === "complete" || value === "input_required" || value === "task") {
    return value;
  }
  return "invalid";
}

function parseInputRequired(
  method: string,
  params: Record<string, unknown> | undefined,
  result: unknown,
  url: string,
): McpInputRequired {
  if (typeof result !== "object" || result === null) {
    throw new McpError(
      `MCP server ${url} sent a malformed input_required result`,
    );
  }
  const record = result as {
    inputRequests?: unknown;
    requestState?: unknown;
    _meta?: Record<string, unknown>;
  };
  if (record.inputRequests === undefined && record.requestState === undefined) {
    throw new McpError(
      `MCP server ${url} sent an input_required result with neither inputRequests nor requestState`,
    );
  }
  if (
    record.requestState !== undefined &&
    typeof record.requestState !== "string"
  ) {
    throw new McpError(`MCP server ${url} sent a non-string requestState`);
  }
  if (record.inputRequests !== undefined) {
    if (
      typeof record.inputRequests !== "object" ||
      record.inputRequests === null ||
      Array.isArray(record.inputRequests)
    ) {
      throw new McpError(
        `MCP server ${url} sent a malformed inputRequests map`,
      );
    }
    for (const value of Object.values(record.inputRequests)) {
      if (
        typeof value !== "object" ||
        value === null ||
        typeof (value as { method?: unknown }).method !== "string"
      ) {
        throw new McpError(`MCP server ${url} sent a malformed input request`);
      }
    }
  }
  return {
    resultType: "input_required",
    method,
    params: stripMeta(params),
    ...(record._meta !== undefined ? { _meta: record._meta } : {}),
    ...(record.inputRequests !== undefined
      ? { inputRequests: record.inputRequests as Record<string, unknown> }
      : {}),
    ...(typeof record.requestState === "string"
      ? { requestState: record.requestState }
      : {}),
  };
}

function parseTask(result: unknown, url: string): McpTaskHandle {
  const parsed = TaskHandleSchema(result);
  if (parsed instanceof type.errors) {
    throw new McpError(
      `MCP server ${url} sent a malformed task handle: ${parsed.summary}`,
    );
  }
  return { resultType: "task", ...parsed };
}

async function requestResult(
  url: string,
  method: string,
  params: Record<string, unknown> | undefined,
  opts: McpClientOptions,
): Promise<unknown> {
  const result = await createMcpRequestTransport(url, opts).request(
    method,
    params,
  );
  const kind = resultKind(result);
  if (kind === "task") return parseTask(result, url);
  if (kind === "input_required")
    return parseInputRequired(method, params, result, url);
  return result;
}

function isInputRequired(result: unknown): result is McpInputRequired {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { resultType?: unknown }).resultType === "input_required"
  );
}

function isTaskHandle(result: unknown): result is McpTaskHandle {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { resultType?: unknown }).resultType === "task"
  );
}

type PageCache = { ttlMs?: number; cacheScope?: McpCacheScope };

function readCache(result: unknown, url: string, method: string): PageCache {
  if (typeof result !== "object" || result === null) return {};
  const record = result as { ttlMs?: unknown; cacheScope?: unknown };
  const cache: PageCache = {};
  if ("ttlMs" in record && record.ttlMs !== undefined) {
    if (typeof record.ttlMs !== "number") {
      throw new McpError(
        `MCP server ${url} sent a non-numeric ttlMs for ${method}`,
      );
    }
    cache.ttlMs = record.ttlMs < 0 ? 0 : record.ttlMs;
  }
  if ("cacheScope" in record && record.cacheScope !== undefined) {
    if (record.cacheScope !== "public" && record.cacheScope !== "private") {
      throw new McpError(
        `MCP server ${url} sent an invalid cacheScope for ${method}`,
      );
    }
    cache.cacheScope = record.cacheScope;
  }
  return cache;
}

function mergeCache(pages: readonly PageCache[]): PageCache {
  let sawTtl = false;
  let omittedTtl = false;
  let ttl = Number.POSITIVE_INFINITY;
  let scope: McpCacheScope | undefined;
  let scopeOnEveryPage = pages.length > 0;
  for (const page of pages) {
    if (page.ttlMs === undefined) omittedTtl = true;
    else {
      sawTtl = true;
      ttl = Math.min(ttl, page.ttlMs);
    }
    if (page.cacheScope === undefined) scopeOnEveryPage = false;
    else if (scope === undefined) scope = page.cacheScope;
    else if (scope !== page.cacheScope) {
      throw new McpError("MCP server changed cacheScope between pages");
    }
  }
  const merged: PageCache = {};
  if (sawTtl) merged.ttlMs = omittedTtl ? 0 : ttl;
  if (scopeOnEveryPage && scope !== undefined) merged.cacheScope = scope;
  return merged;
}

function attachCache<T>(items: T[], cache: PageCache): T[] & PageCache {
  if (cache.ttlMs !== undefined) {
    Object.defineProperty(items, "ttlMs", {
      value: cache.ttlMs,
      enumerable: false,
    });
  }
  if (cache.cacheScope !== undefined) {
    Object.defineProperty(items, "cacheScope", {
      value: cache.cacheScope,
      enumerable: false,
    });
  }
  return items;
}

function nextCursorOf(
  result: unknown,
  url: string,
  method: string,
): string | undefined {
  if (
    typeof result !== "object" ||
    result === null ||
    !("nextCursor" in result)
  ) {
    return undefined;
  }
  const cursor = (result as { nextCursor?: unknown }).nextCursor;
  if (cursor === undefined) return undefined;
  if (typeof cursor !== "string") {
    throw new McpError(
      `MCP server ${url} sent a non-string nextCursor for ${method}`,
    );
  }
  return cursor;
}

async function eachPage(
  url: string,
  method: string,
  base: Record<string, unknown> | undefined,
  opts: McpClientOptions,
): Promise<{ pages: unknown[]; cache: PageCache }> {
  const pages: unknown[] = [];
  const caches: PageCache[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = cursor === undefined ? base : { ...base, cursor };
    const result = await requestResult(
      url,
      method,
      params !== undefined && Object.keys(params).length > 0
        ? params
        : undefined,
      opts,
    );
    if (isInputRequired(result) || isTaskHandle(result)) {
      throw new McpError(
        `MCP server ${url} sent ${result.resultType} for ${method}`,
      );
    }
    pages.push(result);
    caches.push(readCache(result, url, method));
    const next = nextCursorOf(result, url, method);
    if (next === undefined) return { pages, cache: mergeCache(caches) };
    cursor = next;
  }
  throw new McpError(
    `MCP server ${url} sent more than ${String(MAX_PAGES)} ${method} pages`,
  );
}

const ToolsListResult = type({ tools: McpToolSchema.array() });

/** `tools/list`: the remote server's tool catalog, following cursors. */
export async function mcpListTools(
  url: string,
  opts: McpClientOptions = {},
): Promise<McpToolList> {
  const { pages, cache } = await eachPage(url, "tools/list", undefined, opts);
  const tools: McpTool[] = [];
  for (const result of pages) {
    const parsed = ToolsListResult(result);
    if (parsed instanceof type.errors) {
      throw new McpError(
        `MCP server ${url} sent a malformed tools/list result: ${parsed.summary}`,
      );
    }
    for (const tool of parsed.tools) {
      if (collectHeaders(tool.inputSchema, tool.name) === undefined) continue;
      tools.push(tool);
    }
  }
  const names = new Set(tools.map((tool) => tool.name));
  if (names.size !== tools.length) {
    throw new McpError(
      `MCP server ${url} sent a tools/list result with duplicate tool names`,
    );
  }
  return attachCache(tools, cache);
}

/** `tools/call`: invoke a remote tool by name with JSON arguments. */
export async function mcpCallTool(
  url: string,
  name: string,
  toolArguments: Record<string, unknown>,
  opts: McpClientOptions = {},
): Promise<McpToolCallResult> {
  const params = { name, arguments: toolArguments };
  const result = await requestResult(url, "tools/call", params, opts);
  if (isInputRequired(result) || isTaskHandle(result)) return result;
  const parsed = ToolCallResult(result);
  if (parsed instanceof type.errors) {
    throw new McpError(
      `MCP server ${url} sent a malformed tools/call result for ${name}: ${parsed.summary}`,
    );
  }
  return {
    resultType: "complete",
    content: parsed.content,
    ...(parsed.isError !== undefined ? { isError: parsed.isError } : {}),
    ...(parsed.structuredContent !== undefined
      ? { structuredContent: parsed.structuredContent }
      : {}),
    ...(parsed._meta !== undefined ? { _meta: parsed._meta } : {}),
  };
}

/** Retry a call that came back `input_required`, echoing `requestState`. */
export async function mcpContinue(
  url: string,
  pending: McpInputRequired,
  inputResponses: Record<string, unknown>,
  opts: McpClientOptions = {},
): Promise<McpToolCallResult | McpPromptResult | McpResourceReadResult> {
  const params: Record<string, unknown> = { ...pending.params, inputResponses };
  if (pending.requestState !== undefined)
    params.requestState = pending.requestState;
  else delete params.requestState;
  if (pending.method === "tools/call") {
    return continueMethod(url, pending.method, params, opts, (value) => {
      const parsed = ToolCallResult(value);
      if (parsed instanceof type.errors) {
        throw new McpError(
          `MCP server ${url} sent a malformed tools/call result: ${parsed.summary}`,
        );
      }
      return {
        resultType: "complete" as const,
        content: parsed.content,
        ...(parsed.isError !== undefined ? { isError: parsed.isError } : {}),
        ...(parsed.structuredContent !== undefined
          ? { structuredContent: parsed.structuredContent }
          : {}),
        ...(parsed._meta !== undefined ? { _meta: parsed._meta } : {}),
      };
    });
  }
  if (pending.method === "prompts/get") {
    return continueMethod(url, pending.method, params, opts, (value) => {
      const parsed = PromptResult(value);
      if (parsed instanceof type.errors) {
        throw new McpError(
          `MCP server ${url} sent a malformed prompts/get result: ${parsed.summary}`,
        );
      }
      return completePrompt(parsed);
    });
  }
  if (pending.method === "resources/read") {
    return continueMethod(url, pending.method, params, opts, (value) =>
      completeRead(value, url),
    );
  }
  throw new McpError(`cannot retry ${pending.method}`);
}

async function continueMethod<T>(
  url: string,
  method: string,
  params: Record<string, unknown>,
  opts: McpClientOptions,
  complete: (result: unknown) => T,
): Promise<T | McpInputRequired | McpTaskHandle> {
  const result = await requestResult(url, method, params, opts);
  if (isInputRequired(result) || isTaskHandle(result)) return result;
  return complete(result);
}

export type McpPrompt = typeof PromptSchema.infer;
export type McpPromptList = McpPrompt[] & PageCache;

export type McpPromptResult =
  | {
      resultType: "complete";
      description?: string;
      messages: unknown[];
      _meta?: Record<string, unknown>;
    }
  | McpInputRequired
  | McpTaskHandle;

function completePrompt(parsed: typeof PromptResult.infer): McpPromptResult {
  return {
    resultType: "complete",
    messages: parsed.messages,
    ...(parsed.description !== undefined
      ? { description: parsed.description }
      : {}),
    ...(parsed._meta !== undefined ? { _meta: parsed._meta } : {}),
  };
}

/** `prompts/list`, following cursors. */
export async function mcpListPrompts(
  url: string,
  opts: McpClientOptions = {},
): Promise<McpPromptList> {
  const { pages, cache } = await eachPage(url, "prompts/list", undefined, opts);
  const prompts: McpPrompt[] = [];
  for (const result of pages) {
    const parsed = type({ prompts: PromptSchema.array() })(result);
    if (parsed instanceof type.errors) {
      throw new McpError(
        `MCP server ${url} sent a malformed prompts/list result: ${parsed.summary}`,
      );
    }
    prompts.push(...parsed.prompts);
  }
  return attachCache(prompts, cache);
}

/** `prompts/get`. */
export async function mcpGetPrompt(
  url: string,
  name: string,
  args: Record<string, string> | undefined,
  opts: McpClientOptions = {},
): Promise<McpPromptResult> {
  const params: Record<string, unknown> = { name };
  if (args !== undefined) params.arguments = args;
  return continueMethod(url, "prompts/get", params, opts, (result) => {
    const parsed = PromptResult(result);
    if (parsed instanceof type.errors) {
      throw new McpError(
        `MCP server ${url} sent a malformed prompts/get result: ${parsed.summary}`,
      );
    }
    return completePrompt(parsed);
  });
}

export type McpResource = typeof ResourceSchema.infer;
export type McpResourceList = McpResource[] & PageCache;

export type McpResourceTemplate = typeof TemplateSchema.infer;
export type McpResourceTemplateList = McpResourceTemplate[] & PageCache;

export type McpResourceReadResult =
  | {
      resultType: "complete";
      contents: unknown[];
      _meta?: Record<string, unknown>;
      ttlMs?: number;
      cacheScope?: McpCacheScope;
    }
  | McpInputRequired
  | McpTaskHandle;

function completeRead(result: unknown, url: string): McpResourceReadResult {
  const parsed = type({
    contents: "unknown[]",
    "_meta?": "Record<string, unknown>",
  })(result);
  if (parsed instanceof type.errors) {
    throw new McpError(
      `MCP server ${url} sent a malformed resources/read result: ${parsed.summary}`,
    );
  }
  const cache = readCache(result, url, "resources/read");
  return {
    resultType: "complete",
    contents: parsed.contents,
    ...(parsed._meta !== undefined ? { _meta: parsed._meta } : {}),
    ...(cache.ttlMs !== undefined ? { ttlMs: cache.ttlMs } : {}),
    ...(cache.cacheScope !== undefined ? { cacheScope: cache.cacheScope } : {}),
  };
}

/** `resources/list`, following cursors. */
export async function mcpListResources(
  url: string,
  opts: McpClientOptions = {},
): Promise<McpResourceList> {
  const { pages, cache } = await eachPage(
    url,
    "resources/list",
    undefined,
    opts,
  );
  const resources: McpResource[] = [];
  for (const result of pages) {
    const parsed = type({ resources: ResourceSchema.array() })(result);
    if (parsed instanceof type.errors) {
      throw new McpError(
        `MCP server ${url} sent a malformed resources/list result: ${parsed.summary}`,
      );
    }
    resources.push(...parsed.resources);
  }
  return attachCache(resources, cache);
}

/** `resources/read`. */
export async function mcpReadResource(
  url: string,
  uri: string,
  opts: McpClientOptions = {},
): Promise<McpResourceReadResult> {
  return continueMethod(url, "resources/read", { uri }, opts, (result) =>
    completeRead(result, url),
  );
}

/** `resources/templates/list`, following cursors. */
export async function mcpListResourceTemplates(
  url: string,
  opts: McpClientOptions = {},
): Promise<McpResourceTemplateList> {
  const { pages, cache } = await eachPage(
    url,
    "resources/templates/list",
    undefined,
    opts,
  );
  const templates: McpResourceTemplate[] = [];
  for (const result of pages) {
    const parsed = type({ resourceTemplates: TemplateSchema.array() })(result);
    if (parsed instanceof type.errors) {
      throw new McpError(
        `MCP server ${url} sent a malformed resources/templates/list result: ${parsed.summary}`,
      );
    }
    templates.push(...parsed.resourceTemplates);
  }
  return attachCache(templates, cache);
}

export type McpCompletion = typeof CompletionResult.infer;

export type McpCompletionRef =
  | { readonly type: "ref/prompt"; readonly name: string }
  | { readonly type: "ref/resource"; readonly uri: string };

/** `completion/complete`. */
export async function mcpComplete(
  url: string,
  ref: McpCompletionRef,
  argument: { name: string; value: string },
  opts: McpClientOptions & {
    context?: Record<string, string>;
  } = {},
): Promise<McpCompletion> {
  const params: Record<string, unknown> = { ref, argument };
  if (opts.context !== undefined) params.context = { arguments: opts.context };
  const result = await requestResult(url, "completion/complete", params, opts);
  if (isInputRequired(result) || isTaskHandle(result)) {
    throw new McpError(
      `MCP server ${url} sent ${result.resultType} for completion/complete`,
    );
  }
  const parsed = CompletionResult(result);
  if (parsed instanceof type.errors) {
    throw new McpError(
      `MCP server ${url} sent a malformed completion/complete result: ${parsed.summary}`,
    );
  }
  return parsed;
}

export type McpNotification = {
  method: string;
  params?: Record<string, unknown>;
  subscriptionId?: string | number;
};

/** Extension methods and the listen stream are 2026-only. A missing session
 * still speaks 2026; a legacy session does not. */
function asModern(opts: McpClientOptions): McpClientOptions {
  if (opts.session === undefined) {
    return {
      ...opts,
      session: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        clientCapabilities: clientCapabilities(opts),
        ...(opts.extensions !== undefined && opts.extensions.length > 0
          ? { extensions: opts.extensions }
          : {}),
        ...(opts.uiMimeTypes !== undefined
          ? { uiMimeTypes: opts.uiMimeTypes }
          : {}),
      },
    };
  }
  if (!isModernSession(opts.session)) {
    throw new McpError(`this method requires protocol ${MCP_PROTOCOL_VERSION}`);
  }
  return opts;
}

function subscriptionParams(
  filter: McpSubscriptionFilter,
): Record<string, unknown> {
  const notifications: Record<string, unknown> = {};
  if (filter.toolsListChanged !== undefined) {
    notifications.toolsListChanged = filter.toolsListChanged;
  }
  if (filter.promptsListChanged !== undefined) {
    notifications.promptsListChanged = filter.promptsListChanged;
  }
  if (filter.resourcesListChanged !== undefined) {
    notifications.resourcesListChanged = filter.resourcesListChanged;
  }
  if (filter.resourceSubscriptions !== undefined) {
    notifications.resourceSubscriptions = [...filter.resourceSubscriptions];
  }
  if (filter.taskIds !== undefined) notifications.taskIds = [...filter.taskIds];
  return { notifications };
}

function asNotification(message: {
  method: string;
  params?: Record<string, unknown>;
}): McpNotification {
  const meta = message.params?._meta;
  let subscriptionId: string | number | undefined;
  if (typeof meta === "object" && meta !== null) {
    const id = (meta as Record<string, unknown>)[META_SUBSCRIPTION];
    if (typeof id === "string" || typeof id === "number") subscriptionId = id;
  }
  return {
    method: message.method,
    ...(message.params !== undefined ? { params: message.params } : {}),
    ...(subscriptionId !== undefined ? { subscriptionId } : {}),
  };
}

/**
 * `subscriptions/listen`. Resolves when the server closes the stream with a
 * result after acknowledgement, or rejects when `signal` aborts and closes
 * the stream. Long-lived by default; timeoutMs explicitly bounds its lifetime.
 */
export async function mcpListen(
  url: string,
  filter: McpSubscriptionFilter,
  onNotification: (notification: McpNotification) => void,
  opts: McpClientOptions = {},
): Promise<void> {
  if (filter.taskIds !== undefined) requireExtension(opts, MCP_EXT_TASKS);
  const callOpts = asModern(opts);
  const fetchImpl = callOpts.fetch ?? fetch;
  const id = nextId++;
  const bodyParams = modernParams(subscriptionParams(filter), callOpts, id);
  validateRequest(
    "subscriptions/listen",
    bodyParams,
    validationContext(callOpts),
  );
  const progressToken = record(bodyParams._meta).progressToken as
    | string
    | number
    | undefined;
  const timeout =
    callOpts.timeoutMs === undefined
      ? undefined
      : AbortSignal.timeout(callOpts.timeoutMs);
  const signals = [timeout, opts.signal].filter((s) => s !== undefined);
  const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;
  reserveProgressToken(progressToken);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: requestHeaders(callOpts, "subscriptions/listen", undefined, {}),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "subscriptions/listen",
        params: bodyParams,
      }),
      ...(signal !== undefined ? { signal } : {}),
    });
    if (!response.ok)
      throw await errorFrom(response, url, "subscriptions/listen", signal);
    const contentType = response.headers.get("content-type") ?? "";
    let acknowledged: Record<string, unknown> | undefined;
    const finish = (message: unknown): void => {
      const parsed = JsonRpcResponse(message);
      if (
        parsed instanceof type.errors ||
        !isResponseTo(message, id) ||
        (parsed.error !== undefined && Object.hasOwn(parsed, "result"))
      ) {
        throw new McpError(
          `MCP server ${url} sent a malformed response to subscriptions/listen`,
        );
      }
      if (parsed.error !== undefined) {
        throw new McpError(
          `MCP server ${url} rejected subscriptions/listen: ${parsed.error.message}`,
          undefined,
          parsed.error.code,
          parsed.error.data,
          { source: "peer" },
        );
      }
      if (acknowledged === undefined)
        throw new McpError("subscription result preceded acknowledgement");
      const result = validateResult(
        "subscriptions/listen",
        parsed.result,
        validationContext(callOpts),
      );
      const metadata = result._meta as Record<string, unknown> | undefined;
      if (metadata?.[META_SUBSCRIPTION] !== id)
        throw new McpError("subscription result has mismatched subscriptionId");
    };
    if (!contentType.includes("text/event-stream")) {
      finish(parseJson(await readCapped(response, signal)));
      return;
    }
    for await (const message of sseMessages(response, signal)) {
      if (isNotification(message)) {
        validateNotification(
          message.method,
          message.params,
          validationContext(callOpts),
        );
        const notification = asNotification(message);
        if (notification.subscriptionId !== id)
          throw new McpError(
            "subscription notification has mismatched subscriptionId",
          );
        if (message.method === "notifications/subscriptions/acknowledged") {
          if (acknowledged !== undefined)
            throw new McpError("duplicate subscription acknowledgement");
          acknowledged = message.params?.notifications as Record<
            string,
            unknown
          >;
          for (const [key, value] of Object.entries(acknowledged)) {
            const requested = (filter as Record<string, unknown>)[key];
            if (
              Array.isArray(value)
                ? !Array.isArray(requested) ||
                  value.some((item) => !requested.includes(item))
                : value === true && requested !== true
            )
              throw new McpError(
                "subscription acknowledged an unrequested filter",
              );
          }
        } else {
          if (acknowledged === undefined)
            throw new McpError(
              "subscription notification preceded acknowledgement",
            );
          const keys: Record<string, string> = {
            "notifications/tools/list_changed": "toolsListChanged",
            "notifications/prompts/list_changed": "promptsListChanged",
            "notifications/resources/list_changed": "resourcesListChanged",
          };
          const key = keys[message.method];
          const allowed =
            key !== undefined
              ? acknowledged[key] === true
              : message.method === "notifications/resources/updated"
                ? Array.isArray(acknowledged.resourceSubscriptions) &&
                  acknowledged.resourceSubscriptions.includes(
                    message.params?.uri,
                  )
                : message.method === "notifications/tasks"
                  ? Array.isArray(acknowledged.taskIds) &&
                    acknowledged.taskIds.includes(message.params?.taskId)
                  : false;
          if (!allowed)
            throw new McpError("unrequested subscription notification");
        }
        onNotification(notification);
        continue;
      }
      if (isResponseTo(message, id)) {
        finish(message);
        return;
      }
    }
    throw new McpError(
      "MCP server closed the event stream without a matching response",
    );
  } catch (cause) {
    if (opts.signal?.aborted === true) {
      throw new McpError(
        `subscriptions/listen to MCP server ${url} was cancelled`,
        undefined,
        undefined,
        undefined,
        { cancelled: true },
      );
    }
    if (timeout?.aborted === true) {
      throw new McpError(
        `MCP server ${url} did not answer subscriptions/listen within ${String(callOpts.timeoutMs)}ms`,
        undefined,
        undefined,
        undefined,
        { timedOut: true },
      );
    }
    throw cause;
  } finally {
    if (progressToken !== undefined) activeProgressTokens.delete(progressToken);
  }
}

function parseTaskState(
  result: unknown,
  _url: string,
  _method: string,
): McpTask {
  return { ...validateTask(result, true), resultType: "complete" };
}

/** `tasks/get`. Requires the tasks extension. */
export async function mcpGetTask(
  url: string,
  taskId: string,
  opts: McpClientOptions = {},
): Promise<McpTask> {
  requireExtension(opts, MCP_EXT_TASKS);
  const result = await requestResult(
    url,
    "tasks/get",
    { taskId },
    asModern(opts),
  );
  if (isInputRequired(result) || isTaskHandle(result)) {
    throw new McpError(
      `MCP server ${url} sent ${result.resultType} for tasks/get`,
    );
  }
  return parseTaskState(result, url, "tasks/get");
}

/** `tasks/update`. Requires the tasks extension. */
export async function mcpUpdateTask(
  url: string,
  taskId: string,
  inputResponses: Record<string, unknown>,
  opts: McpClientOptions = {},
): Promise<void> {
  requireExtension(opts, MCP_EXT_TASKS);
  const result = await requestResult(
    url,
    "tasks/update",
    { taskId, inputResponses },
    asModern(opts),
  );
  if (isInputRequired(result) || isTaskHandle(result)) {
    throw new McpError(
      `MCP server ${url} sent ${result.resultType} for tasks/update`,
    );
  }
}

/** `tasks/cancel`. Requires the tasks extension. Cooperative: the server only acknowledges. */
export async function mcpCancelTask(
  url: string,
  taskId: string,
  opts: McpClientOptions = {},
): Promise<void> {
  requireExtension(opts, MCP_EXT_TASKS);
  const result = await requestResult(
    url,
    "tasks/cancel",
    { taskId },
    asModern(opts),
  );
  if (isInputRequired(result) || isTaskHandle(result)) {
    throw new McpError(
      `MCP server ${url} sent ${result.resultType} for tasks/cancel`,
    );
  }
}

export type McpSkill = typeof SkillSchema.infer;
export type McpSkillList = McpSkill[] & PageCache;

function requireSkills(opts: McpClientOptions): void {
  requireExtension(opts, MCP_EXT_SKILLS);
  const extensions = opts.session?.capabilities?.extensions;
  if (
    typeof extensions !== "object" ||
    extensions === null ||
    !Object.hasOwn(extensions, MCP_EXT_SKILLS)
  ) {
    throw new McpError(
      "server has not declared the skills extension; discover before calling skills methods",
    );
  }
}

/** `skills/list`, following cursors. Requires the skills extension. */
export async function mcpListSkills(
  url: string,
  opts: McpClientOptions = {},
): Promise<McpSkillList> {
  requireSkills(opts);
  const { pages, cache } = await eachPage(
    url,
    "skills/list",
    undefined,
    asModern(opts),
  );
  const skills: McpSkill[] = [];
  for (const result of pages) {
    const parsed = type({ skills: SkillSchema.array() })(result);
    if (parsed instanceof type.errors) {
      throw new McpError(
        `MCP server ${url} sent a malformed skills/list result: ${parsed.summary}`,
      );
    }
    skills.push(...parsed.skills);
  }
  return attachCache(skills, cache);
}

export type McpSkillResult = {
  resultType: "complete";
  skill: McpSkill;
  ttlMs?: number;
  cacheScope?: McpCacheScope;
};

/** `skills/get`. Requires the skills extension. */
export async function mcpGetSkill(
  url: string,
  uri: string,
  opts: McpClientOptions = {},
): Promise<McpSkillResult> {
  requireSkills(opts);
  const result = await requestResult(
    url,
    "skills/get",
    { uri },
    asModern(opts),
  );
  if (isInputRequired(result) || isTaskHandle(result)) {
    throw new McpError(
      `MCP server ${url} sent ${result.resultType} for skills/get`,
    );
  }
  const parsed = type({ skill: SkillSchema })(result);
  if (parsed instanceof type.errors) {
    throw new McpError(
      `MCP server ${url} sent a malformed skills/get result: ${parsed.summary}`,
    );
  }
  const cache = readCache(result, url, "skills/get");
  return {
    resultType: "complete",
    skill: parsed.skill,
    ...(cache.ttlMs !== undefined ? { ttlMs: cache.ttlMs } : {}),
    ...(cache.cacheScope !== undefined ? { cacheScope: cache.cacheScope } : {}),
  };
}

function directoryReadEnabled(session: McpSession | undefined): boolean {
  const capabilities = session?.capabilities;
  if (typeof capabilities !== "object" || capabilities === null) return false;
  const extensions = (capabilities as { extensions?: unknown }).extensions;
  if (typeof extensions !== "object" || extensions === null) return false;
  const skills = (extensions as Record<string, unknown>)[MCP_EXT_SKILLS];
  if (typeof skills !== "object" || skills === null) return false;
  return (skills as { directoryRead?: unknown }).directoryRead === true;
}

/**
 * `resources/directory/read`. Sent only when the skills extension is enabled
 * and the server declared `directoryRead`.
 */
export async function mcpReadResourceDirectory(
  url: string,
  uri: string,
  opts: McpClientOptions = {},
): Promise<McpResourceList> {
  requireSkills(opts);
  const modern = asModern(opts);
  if (!directoryReadEnabled(modern.session)) {
    throw new McpError(
      `MCP server did not declare ${MCP_EXT_SKILLS} directoryRead`,
    );
  }
  const { pages, cache } = await eachPage(
    url,
    "resources/directory/read",
    { uri },
    modern,
  );
  const resources: McpResource[] = [];
  for (const result of pages) {
    const parsed = type({ resources: ResourceSchema.array() })(result);
    if (parsed instanceof type.errors) {
      throw new McpError(
        `MCP server ${url} sent a malformed resources/directory/read result: ${parsed.summary}`,
      );
    }
    resources.push(...parsed.resources);
  }
  return attachCache(resources, cache);
}
