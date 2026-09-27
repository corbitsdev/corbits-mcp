// One `@intx/agent` tool per remote MCP tool, named `<server>.<tool>` so
// each is grantable individually. Discovery runs up front because
// `createAgent` calls a tool factory synchronously.

import {
  defineTool,
  type AnnotatedToolFactory,
  type BaseEnv,
  type ToolDeclaration,
} from "@intx/agent";
import type { ToolCall, ToolDefinition, ToolResult } from "@intx/types/runtime";
import type { FetchLike } from "@intx/harness";
import type { CredentialCapability } from "@intx/types";

import {
  mcpCallTool,
  mcpInitialize,
  mcpListTools,
  type McpTool,
} from "./client.js";
import { isAskExempt, qualifiedName, toolDescription } from "./naming.js";

export interface McpServerConfig {
  /** Namespace prefix for this server's tools: `<name>.<remote-tool-name>`. */
  name: string;
  url: string;
  /**
   * Declared credential handle (must appear in this package's
   * `interchange.credentials`) this server's requests authenticate with.
   * Omit for a server that needs no credential.
   */
  credentialHandle?: string;
}

export interface McpToolsEnv extends BaseEnv {
  /** The consumer-scoped `credentials` capability; see `tools/linear`'s `LinearEnv`. */
  readonly credentials?: CredentialCapability;
}

export interface McpToolsOptions {
  servers: McpServerConfig[];
  /**
   * `<server>.<tool>` names allowed to float below the `ask` floor onto
   * `allow` from a resolved `allow` grant. Every generated tool starts
   * `ask`-marked; this list is the only way to lower one, and it never
   * applies to a remote tool the server flags `destructiveHint: true` --
   * that flag wins no matter what the operator lists here.
   */
  allowWithoutAsk?: string[];
}

async function resolveFetch(
  server: McpServerConfig,
  credentials: CredentialCapability | undefined,
): Promise<FetchLike | undefined> {
  if (server.credentialHandle === undefined) return undefined;
  if (credentials === undefined) {
    throw new Error(
      `MCP server "${server.name}" declares credentialHandle "${server.credentialHandle}" but no credentials capability was supplied`,
    );
  }
  const mediated = await credentials.resolve(server.credentialHandle);
  return (input, init) => mediated.fetch(input, init);
}

interface DiscoveredTool {
  server: McpServerConfig;
  tool: McpTool;
  qualified: string;
}

/**
 * Discover every server's tool catalog and build the `@corbits/mcp` tool
 * factory. Called directly from agent-authoring code (same pattern as
 * `tools/linear`'s `linearTools`), not via the sidecar's dynamic
 * package loader -- that loader requires a package's `interchange.tools`
 * export to already be an `AnnotatedToolFactory`, which discovery's
 * network round trip rules out.
 */
export async function mcpTools(
  options: McpToolsOptions,
  discoveryEnv: { credentials?: CredentialCapability } = {},
): Promise<AnnotatedToolFactory<McpToolsEnv>> {
  const allowWithoutAsk = options.allowWithoutAsk ?? [];
  const discovered: DiscoveredTool[] = [];

  for (const server of options.servers) {
    const clientFetch = await resolveFetch(server, discoveryEnv.credentials);
    const clientOpts = clientFetch !== undefined ? { fetch: clientFetch } : {};
    await mcpInitialize(server.url, clientOpts);
    const tools = await mcpListTools(server.url, clientOpts);
    for (const tool of tools) {
      discovered.push({
        server,
        tool,
        qualified: qualifiedName(server.name, tool.name),
      });
    }
  }

  const definitions: ToolDeclaration[] = discovered.map(
    ({ qualified, tool }) => ({
      name: qualified,
      ...(isAskExempt(qualified, tool, allowWithoutAsk)
        ? {}
        : { approval: "ask" as const }),
    }),
  );

  return defineTool<McpToolsEnv>({
    id: "@corbits/mcp/servers",
    // Optional like `tools/github`'s: only servers that declare a
    // `credentialHandle` need `env.credentials` at all.
    requires: [],
    definitions,
    factory: (env) => {
      const byName = new Map(discovered.map((d) => [d.qualified, d]));
      const toolDefinitions: ToolDefinition[] = discovered.map(
        ({ qualified, tool, server }) => ({
          name: qualified,
          description: toolDescription(tool, server.name),
          inputSchema: tool.inputSchema,
        }),
      );
      const fetchByServer = new Map<string, Promise<FetchLike | undefined>>();
      for (const server of options.servers) {
        fetchByServer.set(server.name, resolveFetch(server, env.credentials));
      }

      return {
        definitions: toolDefinitions,
        async run(call: ToolCall, _signal: AbortSignal): Promise<ToolResult> {
          const found = byName.get(call.name);
          if (found === undefined) {
            return {
              callId: call.id,
              isError: true,
              content: `unknown MCP tool: ${call.name}`,
            };
          }
          try {
            const clientFetch = await fetchByServer.get(found.server.name);
            const result = await mcpCallTool(
              found.server.url,
              found.tool.name,
              call.arguments,
              clientFetch !== undefined ? { fetch: clientFetch } : {},
            );
            return {
              callId: call.id,
              isError: result.isError === true,
              content:
                typeof result.content === "string"
                  ? result.content
                  : JSON.stringify(result.content),
            };
          } catch (err) {
            return {
              callId: call.id,
              isError: true,
              content: err instanceof Error ? err.message : String(err),
            };
          }
        },
      };
    },
  });
}
