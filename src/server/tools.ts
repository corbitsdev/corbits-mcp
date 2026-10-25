import type { McpAuthPolicy } from "../auth/contracts.js";
import {
  McpError,
  validateSchema,
  validateInstance,
} from "../protocol/index.js";
import type {
  McpOperationOutcome,
  McpProviders,
  McpRequestContext,
} from "./contracts.js";

export type McpToolBinding = {
  definition: {
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    [key: string]: unknown;
  };
  resource: string;
  action: string;
  visible?: (context: McpRequestContext) => boolean;
  execute: (
    args: Record<string, unknown>,
    context: McpRequestContext,
    params: Record<string, unknown>,
  ) => McpOperationOutcome | Promise<McpOperationOutcome>;
};

function activePolicy(
  providerAuth: McpAuthPolicy | "public",
  serverAuth: McpAuthPolicy | "public",
): "public" | Pick<McpAuthPolicy, "authorize"> {
  if (providerAuth === "public") return serverAuth;
  if (serverAuth === "public" || serverAuth === providerAuth)
    return providerAuth;
  return {
    authorize: async (identity, operation) =>
      (await providerAuth.authorize(identity, operation)) &&
      (await serverAuth.authorize(identity, operation)),
  };
}

/** Finite catalog; authorization is rechecked even after successful discovery. */
export function createToolProviders(
  tools: readonly McpToolBinding[],
  auth: McpAuthPolicy | "public",
): McpProviders {
  const byName = new Map<string, McpToolBinding>();
  for (const tool of tools) {
    if (byName.has(tool.definition.name))
      throw new Error(`Duplicate tool: ${tool.definition.name}`);
    validateSchema(tool.definition.inputSchema);
    if (tool.definition.outputSchema)
      validateSchema(tool.definition.outputSchema);
    byName.set(tool.definition.name, tool);
  }
  const authorizationPairs = [...byName.values()].map((tool) => ({
    resource: tool.resource,
    action: tool.action,
  }));
  const fallback = authorizationPairs[0] ?? {
    resource: "mcp:server",
    action: "discover",
  };
  const allowed = async (tool: McpToolBinding, context: McpRequestContext) => {
    const policy = activePolicy(auth, context.auth);
    return (
      (tool.visible?.(context) ?? true) &&
      (policy === "public" ||
        (context.identity !== null &&
          (await policy.authorize(context.identity, {
            resource: tool.resource,
            action: tool.action,
          }))))
    );
  };
  return {
    "tools/list": {
      resource: fallback.resource,
      action: fallback.action,
      authorizationPairs,
      authorization: () => null,
      async handle(params, context) {
        if (params.cursor !== undefined)
          throw new McpError("Unknown cursor", 400, -32602);
        const visible = [];
        for (const tool of byName.values())
          if (await allowed(tool, context)) visible.push(tool.definition);
        return { tools: visible };
      },
    },
    "tools/call": {
      resource: fallback.resource,
      action: fallback.action,
      authorizationPairs,
      authorization(params) {
        const tool = byName.get(String(params.name));
        // Null would skip the gate and reveal whether the name is in the catalog.
        return tool ? { resource: tool.resource, action: tool.action } : false;
      },
      schemas(params) {
        const definition = byName.get(String(params.name))?.definition;
        return definition
          ? {
              inputSchema: definition.inputSchema,
              ...(definition.outputSchema
                ? { outputSchema: definition.outputSchema }
                : {}),
            }
          : {};
      },
      async handle(params, context) {
        const tool = byName.get(String(params.name));
        if (!tool || !(await allowed(tool, context)))
          throw new McpError("Tool unavailable", 403, -32602);
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        validateInstance(tool.definition.inputSchema, args);
        const result = await tool.execute(args, context, params);
        if (
          (result.resultType === undefined ||
            result.resultType === "complete") &&
          result.isError !== true &&
          tool.definition.outputSchema
        )
          validateInstance(
            tool.definition.outputSchema,
            result.structuredContent,
          );
        return result;
      },
    },
  };
}
