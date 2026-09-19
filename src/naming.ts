// Naming and the ask floor, shared by the author-time `mcpTools` factory and
// the deployed `mcpServers` sidecar bundle so both project a server's catalog
// onto identical tool names and identical approval marks.

import type { McpTool } from "./client";

/** `<server>.<tool>`, the grantable unit: `tool:<server>.*` covers a server. */
export function qualifiedName(server: string, tool: string): string {
  return `${server}.${tool}`;
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
