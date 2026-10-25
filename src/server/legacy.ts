import { validateMcpIdentity, type McpIdentity } from "../auth/contracts.js";
import {
  MCP_PROTOCOL_VERSION,
  McpError,
  validateLegacyInitialize,
  validateJsonRpcRequest,
  validateRequest,
  validateRequestHeaders,
  validateResult,
  validateNotification,
  record,
} from "../protocol/index.js";
import type {
  JsonRpcRequest,
  JsonRpcNotification,
  McpValidationContext,
} from "../protocol/index.js";
import type {
  McpLegacyRevision,
  McpProviders,
  McpRequestContext,
  McpServerOptions,
} from "./contracts.js";
import { errorPayload } from "./errors.js";

const REVISIONS: readonly McpLegacyRevision[] = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
];
const METHODS = new Set([
  "tools/list",
  "tools/call",
  "prompts/list",
  "prompts/get",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "completion/complete",
]);
type Session = {
  identity: McpIdentity | null;
  version: McpLegacyRevision;
  capabilities: Record<string, unknown>;
  initialized: boolean;
  closed: boolean;
  used: Set<string | number>;
  active: Map<string | number, AbortController>;
  timer: ReturnType<typeof setTimeout>;
  expires: number;
};
const json = (
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
const failed = (error: unknown, id?: string | number) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: errorPayload(error, "Legacy request failed"),
});
const partition = (identity: McpIdentity | null) =>
  identity === null
    ? "public"
    : JSON.stringify([
        identity.tenantId,
        identity.principalId,
        identity.authorizationContextId,
      ]);

/** Isolated legacy transport. No HTTP+SSE endpoint, GET stream, resumption, MRTR or extensions. */
export function createLegacyServer(
  options: McpServerOptions,
  providers: McpProviders,
) {
  const configured = options.legacy?.versions ?? REVISIONS;
  if (
    !configured.length ||
    configured.some((version) => !REVISIONS.includes(version))
  )
    throw new Error("Unsupported legacy revision");
  const versions = REVISIONS.filter((version) => configured.includes(version));
  const ttl = options.legacy?.sessionTtlMs ?? 30 * 60_000;
  const maxSessions = options.legacy?.maxSessions ?? 1024;
  if (
    !Number.isSafeInteger(ttl) ||
    ttl <= 0 ||
    ttl > 2_147_483_647 ||
    !Number.isSafeInteger(maxSessions) ||
    maxSessions <= 0
  )
    throw new Error("Invalid legacy session limits");
  let closed = false;
  function assertOpen() {
    if (closed) throw new McpError("Legacy server is closed", 503, -32603);
  }
  const sessions = new Map<string, Session>();
  const capabilities: Record<string, unknown> = {};
  for (const method of METHODS)
    if (providers[method]) {
      const family = method.split("/")[0]!;
      capabilities[family === "completion" ? "completions" : family] = {};
    }
  function remove(id: string, session: Session) {
    session.closed = true;
    clearTimeout(session.timer);
    sessions.delete(id);
    for (const controller of session.active.values()) controller.abort();
    session.active.clear();
  }
  function lookup(
    request: Request,
    identity: McpIdentity | null,
  ): [string, Session] {
    const id = request.headers.get("Mcp-Session-Id");
    if (!id) throw new McpError("Session ID required", 400, -32600);
    const session = sessions.get(id);
    if (session && session.expires <= Date.now()) remove(id, session);
    if (
      !session ||
      !sessions.has(id) ||
      partition(session.identity) !== partition(identity)
    )
      throw new McpError("Session not found", 404, -32600);
    const version = request.headers.get("MCP-Protocol-Version");
    if (
      (version !== null && version !== session.version) ||
      (version === null && session.version !== "2025-03-26")
    )
      throw new McpError(
        "Protocol version does not match session",
        400,
        -32600,
      );
    return [id, session];
  }
  async function authorized(
    identity: McpIdentity | null,
    resource: string,
    action: string,
  ) {
    return (
      options.auth === "public" ||
      (identity !== null &&
        (await options.auth.authorize(identity, { resource, action })))
    );
  }
  function validation(
    session: Session,
    method: string,
    params: Record<string, unknown>,
  ): McpValidationContext {
    return {
      era: "legacy",
      protocolVersion: session.version,
      extensions: {},
      clientCapabilities: session.capabilities,
      serverCapabilities: capabilities,
      ...providers[method]?.schemas?.(params),
    };
  }
  function notification(message: JsonRpcNotification, session: Session) {
    const params = message.params ?? {};
    if (
      message.method !== "notifications/initialized" &&
      message.method !== "notifications/cancelled"
    )
      throw new McpError("Unsupported notification", 400, -32601);
    validateNotification(message.method, params, {
      era: "legacy",
      extensions: {},
    });
    if (message.method === "notifications/initialized")
      session.initialized = true;
    else session.active.get(params.requestId as string | number)?.abort();
  }
  async function run(
    message: JsonRpcRequest,
    request: Request,
    session: Session,
    identity: McpIdentity | null,
    send: (value: unknown) => void,
  ) {
    const id = message.id;
    let controller: AbortController | undefined;
    let abortListener: (() => void) | undefined;
    try {
      if (session.used.has(id))
        throw new McpError("Request ID already used in session", 400, -32600);
      if (session.used.size >= 10_000)
        throw new McpError(
          "Session request limit reached; initialize a new session",
          429,
          -32600,
        );
      session.used.add(id);
      if (message.method === "ping") return { jsonrpc: "2.0", id, result: {} };
      if (!session.initialized)
        throw new McpError("Session not initialized", 400, -32600);
      if (!METHODS.has(message.method) || !providers[message.method])
        throw new McpError("Method not available in legacy mode", 404, -32601);
      const provider = providers[message.method]!;
      const params = message.params ?? {};
      const pair = provider.authorization
        ? provider.authorization(params)
        : { resource: provider.resource, action: provider.action };
      controller = new AbortController();
      session.active.set(id, controller);
      if (session.expires <= Date.now() || session.closed) controller.abort();
      const signal = controller.signal;
      signal.throwIfAborted();
      const cancelled = new Promise<never>((_resolve, reject) => {
        abortListener = () =>
          reject(new McpError("Request cancelled", undefined, -32603));
        signal.addEventListener("abort", abortListener, { once: true });
      });
      if (
        (pair === false && options.auth !== "public") ||
        (pair !== null &&
          pair !== false &&
          !(await Promise.race([
            authorized(identity, pair.resource, pair.action),
            cancelled,
          ])))
      )
        throw new McpError("Operation forbidden", 403, -32602);
      const context = validation(session, message.method, params);
      validateRequest(message.method, params, context);
      validateRequestHeaders(request.headers, message.method, params, context);
      let lastProgress = -Infinity;
      const providerContext: McpRequestContext = {
        identity,
        auth: options.auth,
        requestId: id,
        protocolVersion: session.version,
        clientCapabilities: session.capabilities,
        signal,
        notify() {
          throw new McpError(
            "Legacy change notifications are not supported",
            400,
            -32601,
          );
        },
        reportProgress(progress, total, message) {
          const token =
            params._meta === undefined
              ? undefined
              : record(params._meta).progressToken;
          if (token === undefined || signal.aborted) return;
          if (progress <= lastProgress)
            throw new McpError("Progress must increase", 500, -32603);
          const notification = {
            progressToken: token,
            progress,
            ...(total === undefined ? {} : { total }),
            ...(message === undefined ? {} : { message }),
          };
          validateNotification("notifications/progress", notification, context);
          lastProgress = progress;
          send({
            jsonrpc: "2.0",
            method: "notifications/progress",
            params: notification,
          });
        },
      };
      signal.throwIfAborted();
      const result = await Promise.race([
        Promise.resolve().then(() => {
          signal.throwIfAborted();
          return provider.handle(params, providerContext);
        }),
        cancelled,
      ]);
      const validated = validateResult(message.method, result, context);
      // Ordinary results only; the shared validator rejects task/MRTR before projection.
      const {
        resultType: _type,
        ttlMs: _ttl,
        cacheScope: _cache,
        ...ordinary
      } = validated;
      if (session.version === "2025-03-26") {
        // Structured tool output and resource links arrived in 2025-06-18.
        // Preserve their information in text for March clients rather than emit
        // a newer content discriminator or silently discard structured data.
        const content = (value: unknown) => {
          const block = record(value);
          return block.type === "resource_link"
            ? {
                type: "text",
                text: `${String(block.name)}: ${String(block.uri)}`,
              }
            : block;
        };
        if (Array.isArray(ordinary.content)) {
          const compatibleContent = ordinary.content.map(content);
          if (ordinary.structuredContent !== undefined)
            compatibleContent.push({
              type: "text",
              text: JSON.stringify(ordinary.structuredContent),
            });
          ordinary.content = compatibleContent;
        }
        if (Array.isArray(ordinary.messages))
          ordinary.messages = ordinary.messages.map((value) => {
            const message = record(value);
            return { ...message, content: content(message.content) };
          });
        delete ordinary.structuredContent;
        if (Array.isArray(ordinary.tools))
          ordinary.tools = ordinary.tools.map((tool) => {
            const { outputSchema: _output, ...definition } = record(tool);
            return definition;
          });
      }
      return { jsonrpc: "2.0", id, result: ordinary };
    } catch (error) {
      return failed(error, id);
    } finally {
      if (controller && abortListener)
        controller.signal.removeEventListener("abort", abortListener);
      if (controller) session.active.delete(id);
    }
  }
  return {
    versions,
    async lifecycle(request: Request): Promise<Response> {
      try {
        assertOpen();
        const rawIdentity =
          options.auth === "public"
            ? null
            : await options.auth.authenticate(request);
        assertOpen();
        if (options.auth !== "public" && !rawIdentity)
          return (
            options.challenge?.(401) ?? new Response(null, { status: 401 })
          );
        const identity =
          rawIdentity === null ? null : validateMcpIdentity(rawIdentity);
        const [id, session] = lookup(request, identity);
        if (request.method === "DELETE") {
          remove(id, session);
          return new Response(null, { status: 204 });
        }
        return new Response(null, {
          status: 405,
          headers: { Allow: "POST, DELETE" },
        });
      } catch (error) {
        return json(
          failed(error),
          error instanceof McpError ? (error.status ?? 400) : 500,
        );
      }
    },
    async handle(
      request: Request,
      body: unknown,
      identity: McpIdentity | null,
    ): Promise<Response | undefined> {
      const entries = Array.isArray(body) ? body : [body];
      const modern =
        request.headers.get("MCP-Protocol-Version") === MCP_PROTOCOL_VERSION ||
        entries.some((entry) => {
          if (entry === null || typeof entry !== "object") return false;
          const params = (entry as Record<string, unknown>).params;
          if (params === null || typeof params !== "object") return false;
          const meta = (params as Record<string, unknown>)._meta;
          return (
            meta !== null &&
            typeof meta === "object" &&
            (meta as Record<string, unknown>)[
              "io.modelcontextprotocol/protocolVersion"
            ] === MCP_PROTOCOL_VERSION
          );
        });
      if (modern) return undefined;
      const first = entries[0];
      const initializing =
        first !== null &&
        typeof first === "object" &&
        (first as Record<string, unknown>).method === "initialize";
      if (
        !initializing &&
        !request.headers.has("Mcp-Session-Id") &&
        request.headers.has("Mcp-Method")
      )
        return undefined;
      let id: string | number | undefined;
      try {
        assertOpen();
        if (initializing && !Array.isArray(body)) {
          const message = validateJsonRpcRequest(body);
          id = message.id;
          if (request.headers.has("Mcp-Session-Id"))
            throw new McpError(
              "Initialize must start a new session",
              400,
              -32600,
            );
          const headerVersion = request.headers.get("MCP-Protocol-Version");
          if (
            headerVersion !== null &&
            !versions.some((version) => version === headerVersion)
          )
            throw new McpError(
              "Unsupported legacy protocol header",
              400,
              -32600,
            );
          const params = validateLegacyInitialize(message.params);
          const permitted = await authorized(
            identity,
            "mcp:server",
            "initialize",
          );
          assertOpen();
          if (!permitted)
            return (
              options.challenge?.(403) ?? new Response(null, { status: 403 })
            );
          for (const [id, session] of sessions)
            if (session.expires <= Date.now()) remove(id, session);
          if (sessions.size >= maxSessions)
            throw new McpError("Legacy session capacity reached", 503, -32603);
          const version =
            versions.find((version) => version === params.protocolVersion) ??
            versions[0]!;
          const sessionId = crypto.randomUUID();
          const session: Session = {
            identity,
            version,
            capabilities: params.capabilities,
            initialized: false,
            closed: false,
            used: new Set([id]),
            active: new Map(),
            expires: Date.now() + ttl,
            timer: setTimeout(() => {
              const current = sessions.get(sessionId);
              if (current) remove(sessionId, current);
            }, ttl),
          };
          session.timer.unref();
          sessions.set(sessionId, session);
          return json(
            {
              jsonrpc: "2.0",
              id,
              result: {
                protocolVersion: version,
                capabilities,
                serverInfo: options.serverInfo,
              },
            },
            200,
            { "Mcp-Session-Id": sessionId },
          );
        }
        const [, session] = lookup(request, identity);
        if (
          Array.isArray(body) &&
          (session.version !== "2025-03-26" || body.length === 0)
        )
          throw new McpError(
            "Batch unsupported for this revision",
            400,
            -32600,
          );
        if (
          entries.some(
            (entry) =>
              entry !== null &&
              typeof entry === "object" &&
              (entry as Record<string, unknown>).method === "initialize",
          )
        )
          throw new McpError(
            "Initialize cannot be batched or repeated",
            400,
            -32600,
          );
        // This shim never issues server-to-client requests, so unsolicited responses
        // cannot be accepted (including the March response-batch shape).
        if (
          entries.some(
            (entry) =>
              entry !== null &&
              typeof entry === "object" &&
              (Object.hasOwn(entry, "result") || Object.hasOwn(entry, "error")),
          )
        )
          throw new McpError("Unsolicited JSON-RPC response", 400, -32600);
        const messages = entries.map((entry) => {
          try {
            return { message: validateJsonRpcRequest(entry, true) };
          } catch (error) {
            return { error: failed(error) };
          }
        });
        if (!Array.isArray(body) && messages[0]?.error)
          return json(messages[0].error, 400);
        if (
          !messages.some(
            (item) => item.error || (item.message && "id" in item.message),
          )
        ) {
          for (const item of messages)
            if (item.message) notification(item.message, session);
          return new Response(null, { status: 202 });
        }
        let disconnected = false;
        const stream = new ReadableStream<Uint8Array>({
          start(sink) {
            const send = (value: unknown) => {
              if (!disconnected)
                sink.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify(value)}\n\n`,
                  ),
                );
            };
            void Promise.all(
              messages.map(async (item) => {
                if (item.error) {
                  send(item.error);
                  return;
                }
                if (!item.message) return;
                if (!("id" in item.message)) {
                  try {
                    notification(item.message, session);
                  } catch {
                    /* Notifications never receive JSON-RPC responses. */
                  }
                  return;
                }
                send(await run(item.message, request, session, identity, send));
              }),
            ).finally(() => {
              if (!disconnected) {
                disconnected = true;
                sink.close();
              }
            });
          },
          // In legacy HTTP a lost connection is NOT a cancellation notification.
          cancel() {
            disconnected = true;
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
          },
        });
      } catch (error) {
        return json(
          failed(error, id),
          error instanceof McpError ? (error.status ?? 400) : 500,
        );
      }
    },
    close() {
      closed = true;
      for (const [id, session] of sessions) remove(id, session);
    },
  };
}
