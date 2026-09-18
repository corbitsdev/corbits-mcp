// The `mcpTools` bundle factory: one `@intx/agent` tool per remote tool on
// each configured MCP server, named `<server>.<tool>` so Interchange's
// native `tool:<name>` grant surface (checked in `@intx/inference`'s
// authz-extension) is individually grantable per remote tool, and
// `tool:<server>.*` covers a whole server. This library adds no gate of
// its own -- it only shapes the declaration every generated tool carries
// so the native gate has the right floor.
//
// Discovery (`initialize` + `tools/list`) happens once, up front, when
// `mcpTools()` is called -- an `AnnotatedToolFactory`'s `definitions` must
// be readable without instantiating it, so the remote catalog has to be
// known before `defineTool` is ever invoked.

import {
  defineTool,
  type AnnotatedToolFactory,
  type BaseEnv,
  type ToolDeclaration,
} from "@intx/agent";
import type { ToolCall, ToolDefinition, ToolResult } from "@intx/types/runtime";
import type { CredentialCapability } from "@intx/types";

import {
  mcpCallTool,
  mcpInitialize,
  mcpListTools,
  type FetchLike,
  type McpTool,
} from "./client";

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
  /**
   * Consumer-scoped credential capability, supplied by the host the same
   * way any other env-DI dependency is. Required only when a configured
   * server declares a `credentialHandle`; resolution is fail-closed per
   * `@intx/harness`'s `createCredentialCapability`.
   */
  mcpCredentials?: CredentialCapability;
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

export function qualifiedName(server: string, tool: string): string {
  return `${server}.${tool}`;
}

function toolDescription(tool: McpTool, server: string): string {
  const hints = Object.entries(tool.annotations ?? {})
    .filter(([, v]) => v === true)
    .map(([k]) => k);
  const base =
    tool.description ?? `Remote tool "${tool.name}" on MCP server "${server}".`;
  return hints.length > 0
    ? `${base} (server annotations: ${hints.join(", ")})`
    : base;
}

/**
 * Whether `qualified` may drop below the `ask` floor: it must be on the
 * operator's `allowWithoutAsk` list AND the remote tool must not be
 * `destructiveHint: true`. Exported so the approval-derivation rule is
 * independently testable from the network-dependent factory build.
 */
export function isAskExempt(
  qualified: string,
  tool: McpTool,
  allowWithoutAsk: readonly string[],
): boolean {
  if (tool.annotations?.destructiveHint === true) return false;
  return allowWithoutAsk.includes(qualified);
}

async function resolveFetch(
  server: McpServerConfig,
  credentials: CredentialCapability | undefined,
): Promise<FetchLike | undefined> {
  if (server.credentialHandle === undefined) return undefined;
  if (credentials === undefined) {
    throw new Error(
      `MCP server "${server.name}" declares credentialHandle "${server.credentialHandle}" but no mcpCredentials capability was supplied`,
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
 * factory. Performs one `initialize` + `tools/list` round trip per server;
 * a discovery-time credential (for servers that need auth to list tools)
 * comes from `env.mcpCredentials` supplied via `discoveryEnv`.
 */
export async function mcpTools(
  options: McpToolsOptions,
  discoveryEnv: { mcpCredentials?: CredentialCapability } = {},
): Promise<AnnotatedToolFactory<McpToolsEnv>> {
  const allowWithoutAsk = options.allowWithoutAsk ?? [];
  const discovered: DiscoveredTool[] = [];

  for (const server of options.servers) {
    const clientFetch = await resolveFetch(server, discoveryEnv.mcpCredentials);
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
        fetchByServer.set(
          server.name,
          resolveFetch(server, env.mcpCredentials),
        );
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
