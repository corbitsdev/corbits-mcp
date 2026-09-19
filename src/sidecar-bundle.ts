// Sidecar-bundle entry for `@corbits/mcp` — the factory a deployed agent's
// tool-package loader invokes, so the agent carries a remote server's tools
// without any agent-owned MCP client code.
//
// The bundle holds no bearer. Each server's credential reaches it only as a
// mediated `http` handle out of the host-assembled runtime capabilities: a
// fetch pinned to that server's origin that injects the token per request.
// The catalog is supplied by whoever deployed the agent (discovered once
// through the hub route), because the loader calls `factory` synchronously
// and the tool definitions are frozen at agent construction — there is no
// point at which this bundle could do a `tools/list` round trip.

import {
  defineTool,
  type AnnotatedToolFactory,
  type BaseEnv,
} from "@intx/agent";
import type { ToolCall, ToolDefinition, ToolResult } from "@intx/types/runtime";
import { type } from "arktype";

import {
  mcpCallTool,
  mcpInitialize,
  McpToolSchema,
  type McpTool,
} from "./client";
import { isAskExempt, qualifiedName, toolDescription } from "./naming";
import { parseMcpEndpoint } from "./url";

/** The consumer key a host matches a credential binding against. */
export const SIDECAR_BUNDLE_ID = "@corbits/mcp/sidecar-bundle";

type MediatedFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type HttpCredential = {
  readonly kind: string;
  fetch: MediatedFetch;
  dispose(): void | Promise<void>;
};

/** The slice of the host-assembled runtime capabilities this bundle uses. */
type CredentialCapabilities = {
  resolve(key: "credentials"): {
    resolve(handle: string): Promise<HttpCredential>;
  };
};

/** The env keys `requires` declares, on top of the core ones. */
export type McpServersEnv = BaseEnv & {
  readonly capabilities: CredentialCapabilities;
};

export interface McpBoundServer {
  /** Credential handle the host bound this server's token to. */
  readonly handle: string;
  /** The server's streamable-HTTP endpoint; the handle is pinned to its origin. */
  readonly url: string;
  /** The catalog a deployer discovered ahead of time through the hub route. */
  readonly tools: readonly McpTool[];
  /**
   * `<handle>.<tool>` names allowed below the `ask` floor. A remote tool the
   * server flags `destructiveHint: true` stays at `ask` regardless.
   */
  readonly allowWithoutAsk?: readonly string[];
}

export interface McpServersConfig {
  readonly servers: readonly McpBoundServer[];
}

const BoundServerSchema = type({
  handle: "string > 0",
  url: "string > 0",
  tools: McpToolSchema.array(),
  "allowWithoutAsk?": "string[]",
});

const ConfigSchema = type({ servers: BoundServerSchema.array() });

/** Validate at construction: a malformed deploy config is a deploy bug, not a
 * tool error the model should see. */
function assertConfig(config: McpServersConfig): void {
  const parsed = ConfigSchema(config);
  if (parsed instanceof type.errors) {
    throw new Error(`invalid @corbits/mcp server config: ${parsed.summary}`);
  }
  const seen = new Set<string>();
  for (const server of config.servers) {
    if (seen.has(server.handle)) {
      throw new Error(
        `invalid @corbits/mcp server config: duplicate credential handle "${server.handle}"`,
      );
    }
    seen.add(server.handle);
    try {
      parseMcpEndpoint(server.url);
    } catch (cause) {
      throw new Error(
        `invalid @corbits/mcp server config: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
}

const TextBlock = type({ type: "'text'", text: "string" }).array();

/**
 * MCP results are never interpreted: text blocks come back as their text so
 * the model reads prose, and anything else is handed over verbatim as JSON.
 */
export function shapeMcpContent(content: unknown): string {
  if (typeof content === "string") return content;
  const blocks = TextBlock(content);
  if (!(blocks instanceof type.errors)) {
    return blocks.map((block) => block.text).join("\n");
  }
  return JSON.stringify(content);
}

/** A mediated handle resolves a relative path against the origin it is pinned
 * to, so the bundle passes the server's path and never names a host. */
function requestPath(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

interface ServerRuntime {
  readonly server: McpBoundServer;
  handle: Promise<HttpCredential> | undefined;
  ready: Promise<MediatedFetch> | undefined;
}

/**
 * The sidecar bundle: one `@intx/agent` tool per catalog entry, named
 * `<handle>.<tool>` so each is grantable on its own. Synchronous, with
 * static definitions — the catalog is already in hand.
 */
export function mcpServers(
  config: McpServersConfig,
): AnnotatedToolFactory<McpServersEnv> {
  assertConfig(config);

  const entries = config.servers.flatMap((server) =>
    server.tools.map((tool) => ({
      server,
      tool,
      qualified: qualifiedName(server.handle, tool.name),
    })),
  );

  const definitions = entries.map(({ qualified, tool, server }) => ({
    name: qualified,
    ...(isAskExempt(qualified, tool, server.allowWithoutAsk ?? [])
      ? {}
      : { approval: "ask" as const }),
  }));

  const toolDefinitions: ToolDefinition[] = entries.map(
    ({ qualified, tool, server }) => ({
      name: qualified,
      description: toolDescription(tool, server.handle),
      inputSchema: tool.inputSchema,
    }),
  );

  return defineTool<McpServersEnv>({
    id: SIDECAR_BUNDLE_ID,
    requires: ["capabilities"] as const,
    definitions,
    factory: (env) => {
      const byName = new Map(entries.map((e) => [e.qualified, e]));
      const runtimes = new Map<string, ServerRuntime>(
        config.servers.map((server) => [
          server.handle,
          { server, handle: undefined, ready: undefined },
        ]),
      );

      /** Resolve-and-initialize once per server, retried after a failure so a
       * transient one does not disable that server for the whole run. */
      function connect(runtime: ServerRuntime): Promise<MediatedFetch> {
        runtime.ready ??= (async () => {
          runtime.handle ??= env.capabilities
            .resolve("credentials")
            .resolve(runtime.server.handle);
          const credential = await runtime.handle;
          if (credential.kind !== "http") {
            throw new Error(
              `the "${runtime.server.handle}" credential is a ${credential.kind} handle; an MCP server needs an http one`,
            );
          }
          const mediated: MediatedFetch = (input, init) =>
            credential.fetch(input, init);
          await mcpInitialize(requestPath(runtime.server.url), {
            fetch: mediated,
          });
          return mediated;
        })().catch((cause: unknown) => {
          runtime.ready = undefined;
          runtime.handle = undefined;
          throw cause instanceof Error ? cause : new Error(String(cause));
        });
        return runtime.ready;
      }

      return {
        definitions: toolDefinitions,
        async run(call: ToolCall, _signal: AbortSignal): Promise<ToolResult> {
          const found = byName.get(call.name);
          const runtime =
            found === undefined ? undefined : runtimes.get(found.server.handle);
          if (found === undefined || runtime === undefined) {
            return {
              callId: call.id,
              isError: true,
              content: `unknown MCP tool: ${call.name}`,
            };
          }
          try {
            const mediated = await connect(runtime);
            const result = await mcpCallTool(
              requestPath(found.server.url),
              found.tool.name,
              call.arguments,
              { fetch: mediated },
            );
            return {
              callId: call.id,
              isError: result.isError === true,
              content: shapeMcpContent(result.content),
            };
          } catch (cause) {
            // One server's failure is that server's tool error, never the
            // agent's: every other bound server keeps working.
            return {
              callId: call.id,
              isError: true,
              content: cause instanceof Error ? cause.message : String(cause),
            };
          }
        },
        async dispose() {
          // Every resolved handle is released even if one release fails; the
          // failures surface together rather than hiding behind the first.
          const failures: unknown[] = [];
          for (const runtime of runtimes.values()) {
            const pending = runtime.handle;
            if (pending === undefined) continue;
            try {
              await (await pending).dispose();
            } catch (cause) {
              failures.push(cause);
            }
          }
          if (failures.length > 0) {
            throw new AggregateError(
              failures,
              "one or more MCP credential handles failed to dispose",
            );
          }
        },
      };
    },
  });
}
