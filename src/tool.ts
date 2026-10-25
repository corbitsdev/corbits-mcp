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
  DEFAULT_TIMEOUT_MS,
  mcpCallTool,
  mcpConnect,
  mcpListTools,
  type McpClientOptions,
  type McpTool,
} from "./client.js";
import {
  assertCatalogNames,
  assertServers,
  isAskExempt,
  isModelVisible,
  qualifiedName,
  toolDescription,
} from "./naming.js";

import {
  assertHostExtensions,
  hostClientOptions,
} from "./interchange/client/capabilities.js";
import { projectToolResult } from "./interchange/client/projection.js";
import type { McpHostServices } from "./interchange/client/contracts.js";

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
  /** Explicit host lifecycle and presentation services. */
  host?: McpHostServices;
  /**
   * `<server>.<tool>` names allowed to float below the `ask` floor onto
   * `allow` from a resolved `allow` grant. Every generated tool starts
   * `ask`-marked; this list is the only way to lower one, and it never
   * applies to a remote tool the server flags `destructiveHint: true` --
   * that flag wins no matter what the operator lists here.
   */
  allowWithoutAsk?: string[];
  /** Per-request bound on every MCP round trip; defaults to 60s. */
  timeoutMs?: number;
  /**
   * Extension ids advertised on every request. Off unless listed. Tools stay
   * the only grantable unit; extensions are not projected into tools.
   */
  extensions?: readonly string[];
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
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  assertHostExtensions(options.extensions, options.host);
  assertServers(options.servers, "MCP server name");
  const discovered: DiscoveredTool[] = [];

  for (const server of options.servers) {
    const clientFetch = await resolveFetch(server, discoveryEnv.credentials);
    const clientOpts = {
      ...(clientFetch !== undefined ? { fetch: clientFetch } : {}),
      timeoutMs,
      ...hostClientOptions(options.host, options.extensions),
      ...(options.extensions !== undefined
        ? { extensions: options.extensions }
        : {}),
    };
    const session = await mcpConnect(server.url, clientOpts);
    const tools = await mcpListTools(server.url, { ...clientOpts, session });
    assertCatalogNames(server.name, tools);
    for (const tool of tools.filter(isModelVisible)) {
      discovered.push({
        server: { ...server },
        tool: structuredClone(tool),
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
      // One session per server, opened on first use and reopened after a
      // failed call in case the server expired it.
      const clientByServer = new Map<string, Promise<McpClientOptions>>();
      function connect(server: McpServerConfig): Promise<McpClientOptions> {
        let client = clientByServer.get(server.name);
        if (client === undefined) {
          client = (async () => {
            const clientFetch = await fetchByServer.get(server.name);
            const opts = {
              ...(clientFetch !== undefined ? { fetch: clientFetch } : {}),
              timeoutMs,
              ...hostClientOptions(options.host, options.extensions),
              ...(options.extensions !== undefined
                ? { extensions: options.extensions }
                : {}),
            };
            const session = await mcpConnect(server.url, opts);
            return { ...opts, session };
          })();
          clientByServer.set(server.name, client);
        }
        return client;
      }

      return {
        definitions: toolDefinitions,
        async run(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
          const found = byName.get(call.name);
          if (found === undefined) {
            return {
              callId: call.id,
              isError: true,
              content: `unknown MCP tool: ${call.name}`,
            };
          }
          try {
            const context = {
              server: found.server.name,
              url: found.server.url,
              tool: found.qualified,
              callId: call.id,
              signal,
            };
            await options.host?.validateCatalog?.(context, found.tool);
            const client: McpClientOptions = {
              ...(await connect(found.server)),
              signal,
              inputSchema: found.tool.inputSchema,
              ...(found.tool.outputSchema === undefined
                ? {}
                : { outputSchema: found.tool.outputSchema }),
            };
            const result = await mcpCallTool(
              found.server.url,
              found.tool.name,
              call.arguments,
              client,
            ).catch((cause: unknown) => {
              clientByServer.delete(found.server.name);
              throw cause;
            });
            return await projectToolResult(
              context,
              result,
              client,
              options.host,
            );
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
