import { type } from "arktype";
import { McpToolSchema, type McpTool } from "../../client.js";
import type { McpHostContext, McpHostServices } from "./contracts.js";

/** Expiry is host-computed from discovery time and server TTL. Private catalogs
 * must remain scoped to one host authorization context, not a global cache. */
export interface McpCatalogSnapshot {
  readonly tools: readonly McpTool[];
  readonly expiresAt: number;
}

/** Install as host.validateCatalog. Refresh never mutates an active tool bundle:
 * any changed entry requires a rebuilt factory and fresh approval derivation. */
export function createCatalogGuard(options: {
  refresh: (context: McpHostContext) => Promise<McpCatalogSnapshot>;
  now?: () => number;
}): NonNullable<McpHostServices["validateCatalog"]> {
  const catalogs = new Map<string, Promise<McpCatalogSnapshot>>();
  const now = options.now ?? Date.now;
  return async (context, tool) => {
    context.signal.throwIfAborted();
    const key = JSON.stringify([context.server, context.url]);
    let snapshot = await catalogs.get(key);
    if (snapshot === undefined || snapshot.expiresAt <= now()) {
      const pending = (async () => {
        const refreshed = await options.refresh(context);
        if (
          !Number.isFinite(refreshed.expiresAt) ||
          refreshed.expiresAt <= now()
        ) {
          throw new Error("MCP catalog refresh returned an expired snapshot");
        }
        const parsed = McpToolSchema.array()(refreshed.tools);
        if (parsed instanceof type.errors) {
          throw new Error(`Invalid refreshed MCP catalog: ${parsed.summary}`);
        }
        return structuredClone(refreshed);
      })();
      catalogs.set(key, pending);
      try {
        snapshot = await pending;
      } catch (cause) {
        if (catalogs.get(key) === pending) catalogs.delete(key);
        throw cause;
      }
    }
    context.signal.throwIfAborted();
    const matches = snapshot.tools.filter(
      (candidate) => candidate.name === tool.name,
    );
    if (matches.length !== 1 || canonical(matches[0]) !== canonical(tool)) {
      throw new Error(
        "MCP catalog changed; rebuild the tool factory and re-evaluate approvals before calling",
      );
    }
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
