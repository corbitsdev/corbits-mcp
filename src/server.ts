import { errorPayload } from "./server/errors.js";
import { createLegacyServer } from "./server/legacy.js";
import { createResourceBudget } from "./protocol/resource-budget.js";
import { validateMcpIdentity } from "./auth/contracts.js";
import {
  MCP_PROTOCOL_VERSION,
  MCP_EXT_TASKS,
  MCP_EXT_SKILLS,
  methodDescriptor,
  validateExtensionSettings,
  negotiateExtensions,
  McpError,
  validateRequest,
  validateJsonRpcRequest,
  validateRequestHeaders,
  validateResult,
  validateNotification,
  record as protocolRecord,
} from "./protocol/index.js";
import type {
  McpValidationContext,
  McpExtensionSettings,
  McpSubscriptionFilter,
} from "./protocol/types.js";
import type {
  McpServerOptions,
  McpServer,
  McpRequestContext,
  McpProvider,
  McpProviders,
} from "./server/contracts.js";
export type * from "./server/contracts.js";
export {
  createTaskProviders,
  createSkillProviders,
} from "./server/extensions.js";
export { createToolProviders } from "./server/tools.js";
export type { McpToolBinding } from "./server/tools.js";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function methodAuthorization(
  provider: McpProvider,
  params: Record<string, unknown>,
): { resource: string; action: string } | null | false {
  return provider.authorization
    ? provider.authorization(params)
    : { resource: provider.resource, action: provider.action };
}

/** Pairs a private discover check may satisfy. No providers means mcp:server/discover. */
function discoverAuthorizations(
  providers: McpProviders,
): { resource: string; action: string }[] {
  const pairs: { resource: string; action: string }[] = [];
  const seen = new Set<string>();
  for (const provider of Object.values(providers)) {
    const listed = provider.authorizationPairs ?? [
      { resource: provider.resource, action: provider.action },
    ];
    for (const pair of listed) {
      const key = `${pair.resource}\0${pair.action}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push(pair);
    }
  }
  if (pairs.length === 0)
    pairs.push({ resource: "mcp:server", action: "discover" });
  return pairs;
}

/** Stateless modern endpoint with an independently gated legacy session transport. */
export function createMcpServer(options: McpServerOptions): McpServer {
  const providers = Object.freeze({ ...options.providers });
  const extensions = validateExtensionSettings(options.extensions ?? {});
  for (const [extension, methods] of [
    [MCP_EXT_TASKS, ["tasks/get", "tasks/update", "tasks/cancel"]],
    [MCP_EXT_SKILLS, ["skills/list", "skills/get", "resources/read"]],
  ] as const) {
    if (extensions[extension] && methods.some((method) => !providers[method]))
      throw new Error(`Missing providers for ${extension}`);
  }
  if (
    extensions[MCP_EXT_SKILLS]?.directoryRead === true &&
    !providers["resources/directory/read"]
  )
    throw new Error("Missing directory read provider");
  const active = new Set<AbortController>();
  let closed = false;
  const capabilities: Record<string, unknown> = {};
  for (const method of Object.keys(providers)) {
    if (method === "server/discover")
      throw new Error("Discovery is server-owned");
    const descriptor = methodDescriptor(method);
    if (!descriptor) throw new Error(`Unknown provider method: ${method}`);
    if (descriptor.extension && !options.extensions?.[descriptor.extension])
      throw new Error(`Extension not enabled: ${descriptor.extension}`);
    if (descriptor.capability) capabilities[descriptor.capability] = {};
    const family = method.split("/")[0];
    if (family === "tools" || family === "prompts" || family === "resources")
      capabilities[family] = {};
    if (family === "completion") capabilities.completions = {};
  }
  if (Object.keys(extensions).length) capabilities.extensions = extensions;
  const legacy = options.legacy
    ? createLegacyServer(options, providers)
    : undefined;

  return {
    async fetch(request) {
      const origin = request.headers.get("origin");
      if (origin && !options.allowedOrigins?.includes(origin))
        return new Response(null, { status: 403 });
      if (closed) return new Response(null, { status: 503 });
      if (request.method !== "POST") {
        if (
          legacy &&
          request.headers.get("MCP-Protocol-Version") !==
            MCP_PROTOCOL_VERSION &&
          (request.method === "DELETE" || request.headers.has("Mcp-Session-Id"))
        )
          return legacy.lifecycle(request);
        return new Response(null, { status: 405, headers: { Allow: "POST" } });
      }
      if (
        request.headers.get("content-type")?.split(";")[0]?.trim() !==
        "application/json"
      )
        return new Response(null, { status: 415 });
      const accept = request.headers.get("accept") ?? "";
      if (
        !accept.includes("application/json") ||
        !accept.includes("text/event-stream")
      )
        return new Response(null, { status: 406 });
      let id: string | number | undefined;
      try {
        const authenticated =
          options.auth === "public"
            ? null
            : await options.auth.authenticate(request);
        if (closed) return new Response(null, { status: 503 });
        if (options.auth !== "public" && !authenticated)
          return (
            options.challenge?.(401) ?? new Response(null, { status: 401 })
          );
        const identity =
          authenticated === null ? null : validateMcpIdentity(authenticated);
        const limit = options.maxRequestBytes ?? 1024 * 1024;
        const reader = request.body?.getReader();
        if (!reader) throw new McpError("Missing request body", 400, -32600);
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > limit) {
            await reader.cancel();
            throw new McpError("Request too large", 413, -32600);
          }
          chunks.push(chunk.value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          throw new McpError("Invalid JSON", 400, -32700);
        }
        const readableId = record(parsed).id;
        if (
          typeof readableId === "string" ||
          (typeof readableId === "number" && Number.isSafeInteger(readableId))
        )
          id = readableId;
        const compatibility = await legacy?.handle(request, parsed, identity);
        if (closed) return new Response(null, { status: 503 });
        if (compatibility) return compatibility;
        const envelope = validateJsonRpcRequest(parsed);
        id = envelope.id;
        const params = record(envelope.params);
        const meta = record(params._meta);
        const validation: McpValidationContext = {
          era: "modern",
          protocolVersion: MCP_PROTOCOL_VERSION,
          clientCapabilities: record(
            meta["io.modelcontextprotocol/clientCapabilities"],
          ),
          serverCapabilities: capabilities,
          extensions: negotiateExtensions(
            extensions,
            record(
              record(meta["io.modelcontextprotocol/clientCapabilities"])
                .extensions,
            ) as McpExtensionSettings,
          ),
          ...providers[envelope.method]?.schemas?.(params),
          // Explicit Skills publication supports bounded resource payloads only.
          maxDecodedBytes:
            envelope.method === "resources/read" && extensions[MCP_EXT_SKILLS]
              ? 16 * 1024 * 1024
              : undefined,
        };
        validateRequestHeaders(
          request.headers,
          envelope.method,
          params,
          validation,
        );
        validateRequest(envelope.method, params, validation);
        if (envelope.method === "server/discover") {
          if (options.auth !== "public") {
            let permitted = false;
            for (const pair of discoverAuthorizations(providers)) {
              if (identity && (await options.auth.authorize(identity, pair))) {
                permitted = true;
                break;
              }
            }
            if (closed) return new Response(null, { status: 503 });
            if (!permitted)
              return (
                options.challenge?.(403) ?? new Response(null, { status: 403 })
              );
          }
          const result = validateResult(
            envelope.method,
            {
              resultType: "complete",
              supportedVersions: [
                MCP_PROTOCOL_VERSION,
                ...(legacy?.versions ?? []),
              ],
              capabilities,
              _meta: {
                "io.modelcontextprotocol/serverInfo": options.serverInfo,
              },
            },
            validation,
          );
          return Response.json(
            { jsonrpc: "2.0", id, result },
            { headers: { "Cache-Control": "no-store" } },
          );
        }
        const provider = providers[envelope.method];
        if (!provider) throw new McpError("Method not found", 404, -32601);
        const pair = methodAuthorization(provider, params);
        if (pair !== null && options.auth !== "public" && identity) {
          const permitted =
            pair !== false && (await options.auth.authorize(identity, pair));
          if (closed) return new Response(null, { status: 503 });
          if (!permitted)
            return (
              options.challenge?.(403) ?? new Response(null, { status: 403 })
            );
        }
        const controller = new AbortController();
        active.add(controller);
        const abort = () => controller.abort(request.signal.reason);
        request.signal.addEventListener("abort", abort, { once: true });
        if (request.signal.aborted) abort();
        const requestId = id;
        const subscription = envelope.method === "subscriptions/listen";
        let acceptedFilter: McpSubscriptionFilter | undefined;
        const correlate = (
          payload: Record<string, unknown>,
        ): Record<string, unknown> =>
          subscription
            ? {
                ...payload,
                _meta: {
                  ...(payload._meta === undefined
                    ? {}
                    : protocolRecord(payload._meta)),
                  "io.modelcontextprotocol/subscriptionId": requestId,
                },
              }
            : payload;
        let ended = false;
        let lastProgress = -Infinity;
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(sink) {
            const send = (message: unknown) => {
              if (!ended) {
                const wire = encoder.encode(
                  `data: ${JSON.stringify(message)}\n\n`,
                );
                if (
                  validation.maxDecodedBytes !== undefined &&
                  record(message).result !== undefined
                ) {
                  const budget = createResourceBudget(
                    validation.maxDecodedBytes,
                    true,
                  );
                  budget.push(wire);
                  budget.finish();
                }
                sink.enqueue(wire);
              }
            };
            const finish = () => {
              if (!ended) {
                ended = true;
                sink.close();
              }
            };
            controller.signal.addEventListener("abort", finish, { once: true });
            if (controller.signal.aborted) finish();
            const context: McpRequestContext = {
              identity,
              auth: options.auth,
              requestId,
              protocolVersion: MCP_PROTOCOL_VERSION,
              clientCapabilities: validation.clientCapabilities ?? {},
              signal: controller.signal,
              reportProgress(progress, total, message) {
                const token = meta.progressToken;
                if (
                  subscription ||
                  token === undefined ||
                  controller.signal.aborted
                )
                  return;
                if (progress <= lastProgress)
                  throw new McpError("Progress must increase", 500, -32603);
                const notification = {
                  progressToken: token,
                  progress,
                  ...(total === undefined ? {} : { total }),
                  ...(message === undefined ? {} : { message }),
                };
                validateNotification(
                  "notifications/progress",
                  notification,
                  validation,
                );
                lastProgress = progress;
                send({
                  jsonrpc: "2.0",
                  method: "notifications/progress",
                  params: notification,
                });
              },
              notify(method, notification) {
                if (envelope.method !== "subscriptions/listen")
                  throw new Error(
                    "Change notifications require subscriptions/listen",
                  );
                if (acceptedFilter === undefined)
                  throw new Error("Subscription is not yet acknowledged");
                const outgoing = correlate(notification);
                validateNotification(method, outgoing, validation);
                const filter = acceptedFilter;
                const listFlag = (
                  {
                    "notifications/tools/list_changed": "toolsListChanged",
                    "notifications/prompts/list_changed": "promptsListChanged",
                    "notifications/resources/list_changed":
                      "resourcesListChanged",
                  } as const
                )[
                  method as
                    | "notifications/tools/list_changed"
                    | "notifications/prompts/list_changed"
                    | "notifications/resources/list_changed"
                ];
                const permitted = listFlag
                  ? filter[listFlag] === true
                  : method === "notifications/resources/updated"
                    ? Array.isArray(filter.resourceSubscriptions) &&
                      filter.resourceSubscriptions.includes(
                        String(notification.uri),
                      )
                    : method === "notifications/tasks"
                      ? Array.isArray(filter.taskIds) &&
                        filter.taskIds.includes(String(notification.taskId))
                      : false;
                if (!permitted) return;
                send({ jsonrpc: "2.0", method, params: outgoing });
              },
            };
            void Promise.resolve()
              .then(async () => {
                controller.signal.throwIfAborted();
                if (subscription) {
                  const requested = structuredClone(
                    record(params.notifications),
                  );
                  const accepted = structuredClone(
                    (await provider.acceptSubscription?.(params, context)) ??
                      {},
                  );
                  controller.signal.throwIfAborted();
                  const acknowledged = correlate({ notifications: accepted });
                  validateNotification(
                    "notifications/subscriptions/acknowledged",
                    acknowledged,
                    validation,
                  );
                  for (const [key, value] of Object.entries(accepted)) {
                    const wanted = requested[key];
                    if (
                      Array.isArray(value)
                        ? !Array.isArray(wanted) ||
                          value.some((item) => !wanted.includes(item))
                        : value === true && wanted !== true
                    ) {
                      throw new McpError(
                        "Accepted subscription exceeds requested filter",
                        500,
                        -32603,
                      );
                    }
                  }
                  acceptedFilter = accepted;
                  send({
                    jsonrpc: "2.0",
                    method: "notifications/subscriptions/acknowledged",
                    params: acknowledged,
                  });
                }
                return provider.handle(params, context);
              })
              .then((result) => {
                const outgoing = {
                  jsonrpc: "2.0",
                  id: requestId,
                  result: validateResult(
                    envelope.method,
                    correlate({
                      ...protocolRecord(result),
                      resultType:
                        result.resultType === undefined
                          ? "complete"
                          : result.resultType,
                    }),
                    validation,
                  ),
                };
                send(outgoing);
              })
              .catch((error: unknown) => {
                send({
                  jsonrpc: "2.0",
                  id: requestId,
                  error: errorPayload(error, "Provider execution failed"),
                });
              })
              .finally(() => {
                active.delete(controller);
                request.signal.removeEventListener("abort", abort);
                controller.signal.removeEventListener("abort", finish);
                finish();
              });
          },
          cancel(reason) {
            ended = true;
            controller.abort(reason);
            active.delete(controller);
            request.signal.removeEventListener("abort", abort);
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
        const known = error instanceof McpError;
        return Response.json(
          {
            jsonrpc: "2.0",
            ...(id === undefined ? {} : { id }),
            error: errorPayload(error, "Request failed"),
          },
          {
            status: known
              ? (error.status ?? (error.code === -32601 ? 404 : 400))
              : 500,
            headers: { "Cache-Control": "no-store" },
          },
        );
      }
    },
    async close() {
      closed = true;
      legacy?.close();
      for (const controller of active) controller.abort();
      active.clear();
    },
  };
}

export { createSkillPublisher } from "./extensions/skills/index.js";
export type * from "./extensions/skills/contracts.js";
export {
  createTaskRuntime,
  validateTaskRecord,
} from "./extensions/tasks/index.js";
export type * from "./extensions/tasks/contracts.js";
export { createMcpResourceServerAuth } from "./auth/resource-server.js";
export type { McpResourceServerOptions } from "./auth/resource-server.js";
export type { McpAuthPolicy, McpIdentity } from "./auth/contracts.js";
