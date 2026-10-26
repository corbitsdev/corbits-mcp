import { type } from "arktype";
import { McpError, validateInstance } from "../protocol/index.js";
import { createToolProviders } from "../server/tools.js";
import type {
  McpOperationOutcome,
  McpProviders,
  McpRequestContext,
} from "../server/contracts.js";
import type {
  InterchangeExposure,
  InterchangeServerOptions,
} from "./server/contracts.js";
export type * from "./server/contracts.js";

const Trigger = type({
  runId: "string > 0",
  address: "string > 0",
  messageId: "string > 0",
});
const textResult = (text: string): McpOperationOutcome => ({
  content: [{ type: "text", text }],
});
const jsonResult = (value: unknown): McpOperationOutcome => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  ...(value !== null && typeof value === "object" && !Array.isArray(value)
    ? { structuredContent: value }
    : {}),
});

function boundUrl(origin: string, path: string): URL {
  const base = new URL(origin);
  if (
    !/^https?:$/.test(base.protocol) ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  )
    throw new Error("Expected a fixed HTTP origin");
  if (!path.startsWith("/") || path.startsWith("//") || /[\\?#{}]/u.test(path))
    throw new Error("Expected a fully bound operation path");
  for (const segment of path.split("/")) {
    const decoded = decodeURIComponent(segment);
    if (
      decoded === "." ||
      decoded === ".." ||
      /[/\\%]/u.test(decoded) ||
      [...decoded].some((character) => character.charCodeAt(0) <= 32)
    )
      throw new Error("Unsafe operation path");
  }
  const url = new URL(path, base);
  if (url.origin !== base.origin) throw new Error("Operation origin mismatch");
  return url;
}

async function responseJson(response: Response): Promise<unknown> {
  if (!response.ok)
    throw new McpError("Interchange operation failed", 502, -32603);
  if (response.status === 204) return {};
  const body = await response.text();
  if (response.status === 202 && body.length === 0) {
    const location = response.headers.get("location");
    // Acceptance is not completion/cancellation; keep the polling hint without following it.
    return {
      status: 202,
      accepted: true,
      ...(location === null ? {} : { location }),
    };
  }
  if (
    response.headers.get("content-type")?.split(";")[0]?.trim() !==
    "application/json"
  )
    throw new McpError(
      "Unsupported Interchange response content type",
      502,
      -32603,
    );
  return JSON.parse(body) as unknown;
}

/** Explicit allowlist only: no hub scanning, factory enumeration, or grant widening. */
export function createInterchangeProviders(
  options: InterchangeServerOptions,
): McpProviders {
  const bindings = options.exposures.map((exposure) => {
    if (!exposure.tenantId || typeof exposure.approve !== "function")
      throw new Error("Tenant binding and approval service required");
    if (exposure.kind === "operation") {
      boundUrl(exposure.origin, exposure.path);
      if (exposure.method === "GET" && exposure.body)
        throw new Error("GET request bodies are unsupported");
    }
    if (exposure.kind === "workflow")
      boundUrl(exposure.origin, workflowPath(exposure));
    if (exposure.kind === "tool") {
      const selected = exposure.bundle.definitions.filter(
        (definition) => definition.name === exposure.toolName,
      );
      if (selected.length !== 1)
        throw new Error(
          "Tool selection must identify one installed definition",
        );
    }
    return {
      definition: exposure.definition,
      resource: exposure.resource,
      action: exposure.action,
      visible: (context: McpRequestContext) =>
        context.identity?.tenantId === exposure.tenantId,
      async execute(
        args: Record<string, unknown>,
        context: McpRequestContext,
        params: Record<string, unknown>,
      ): Promise<McpOperationOutcome> {
        if (
          !context.identity ||
          context.identity.tenantId !== exposure.tenantId
        )
          throw new McpError(
            "Identity is not authorized for this binding",
            403,
            -32602,
          );
        if (!(await exposure.approve(args, context)))
          throw new McpError("Invocation approval required", 403, -32602);
        context.signal.throwIfAborted();
        if (
          params.inputResponses !== undefined ||
          params.requestState !== undefined
        ) {
          if (!exposure.continue)
            throw new McpError("Continuation unavailable", 400, -32602);
          return exposure.continue(params, context);
        }
        switch (exposure.kind) {
          case "tool": {
            const selected = exposure.bundle.definitions.find(
              (definition) => definition.name === exposure.toolName,
            );
            if (!selected)
              throw new Error("Selected tool is no longer available");
            validateInstance(selected.inputSchema, args);
            const result = await exposure.bundle.run(
              {
                id: String(context.requestId),
                name: exposure.toolName,
                arguments: args,
              },
              context.signal,
            );
            if (exposure.projectResult)
              return exposure.projectResult(result, context);
            if (result.pendingMarker)
              throw new McpError(
                "Pending tool requires a lifecycle projection",
                500,
                -32603,
              );
            // detail is deliberately host-only in Interchange; never leak it implicitly.
            return {
              ...(typeof result.content === "string"
                ? textResult(result.content)
                : jsonResult(result.content)),
              ...(result.isError === undefined
                ? {}
                : { isError: result.isError }),
            };
          }
          case "agent": {
            // Agent.send aborts the waiter, not the shared reactor. Never close a shared agent.
            const result = await exposure.agent.send(exposure.message(args), {
              signal: context.signal,
            });
            return result.type === "reply"
              ? textResult(result.reply)
              : exposure.suspended(result, context);
          }
          case "operation": {
            const body = exposure.body?.(args);
            const response = await exposure.dispatch(
              new Request(boundUrl(exposure.origin, exposure.path).href, {
                method: exposure.method,
                signal: context.signal,
                redirect: "error",
                ...(body === undefined
                  ? {}
                  : {
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify(body),
                    }),
              }),
              context.identity,
            );
            return jsonResult(await responseJson(response));
          }
          case "workflow": {
            const intentId = await exposure.prepare(args, context);
            if (!intentId) throw new Error("Durable dispatch intent required");
            context.signal.throwIfAborted();
            const response = await exposure.dispatch(
              new Request(
                boundUrl(exposure.origin, workflowPath(exposure)).href,
                {
                  method: "POST",
                  signal: context.signal,
                  redirect: "error",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ content: exposure.message(args) }),
                },
              ),
              context.identity,
            );
            const trigger = Trigger(await responseJson(response));
            if (trigger instanceof type.errors)
              throw new Error("Invalid workflow trigger response");
            await exposure.recordTrigger(intentId, trigger, context);
            return exposure.selectResult(trigger, context);
          }
        }
      },
    };
  });
  return createToolProviders(bindings, options.auth);
}

function workflowPath(
  exposure: Extract<InterchangeExposure, { kind: "workflow" }>,
): string {
  return `/api/tenants/${encodeURIComponent(exposure.tenantId)}/workflows/${encodeURIComponent(exposure.deploymentId)}/mail`;
}
