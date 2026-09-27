// Naming and the ask floor, shared by the author-time `mcpTools` factory and
// the deployed `mcpServers` sidecar bundle so both project a server's catalog
// onto identical tool names and identical approval marks.

import type { McpTool } from "./client.js";
import { parseMcpEndpoint } from "./url.js";

/** `<server>.<tool>`, the grantable unit: `tool:<server>.*` covers a server. */
export function qualifiedName(server: string, tool: string): string {
  return `${server}.${tool}`;
}

/**
 * Refuse a catalog whose names could reach another server's grants: a server
 * name with a `.` could make `<server>.<tool>` fall under another server's
 * `tool:<other>.*`, and a repeated tool name would make two tools one name.
 */
export function assertCatalogNames(
  server: string,
  tools: readonly McpTool[],
): void {
  if (server.includes(".")) {
    throw new Error(
      `MCP server name "${server}" must not contain "."; it would overlap another server's grants`,
    );
  }
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      throw new Error(
        `MCP server "${server}" lists the tool "${tool.name}" more than once`,
      );
    }
    seen.add(tool.name);
  }
}

/**
 * Refuse a server list before any request: every name non-empty and unique,
 * so no two servers share a grant prefix, and every URL a permitted endpoint.
 */
export function assertServers(
  servers: readonly { name: string; url: string }[],
  label: string,
): void {
  const seen = new Set<string>();
  for (const { name, url } of servers) {
    if (name.length === 0) throw new Error(`empty ${label}`);
    if (seen.has(name)) throw new Error(`duplicate ${label} "${name}"`);
    seen.add(name);
    parseMcpEndpoint(url);
  }
}

export function toolDescription(tool: McpTool, server: string): string {
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
 * `destructiveHint: true` -- that flag wins no matter what is listed.
 */
export function isAskExempt(
  qualified: string,
  tool: McpTool,
  allowWithoutAsk: readonly string[],
): boolean {
  if (tool.annotations?.destructiveHint === true) return false;
  return allowWithoutAsk.includes(qualified);
}
