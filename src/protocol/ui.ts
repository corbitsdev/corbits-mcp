import { McpError, McpErrorCode } from "./errors.js";
import { assertJsonBounds } from "./json-schema.js";
import type { McpUiToolMeta } from "./types.js";
/** Validate the value of a tool's _meta.ui, preserving future metadata fields. */
export function validateUiToolMeta(value: unknown): McpUiToolMeta {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new McpError(
      "invalid tool UI metadata",
      undefined,
      McpErrorCode.InvalidParams,
    );
  assertJsonBounds(value);
  const metadata = value as Record<string, unknown>;
  if (
    metadata.resourceUri !== undefined &&
    (typeof metadata.resourceUri !== "string" ||
      !metadata.resourceUri.startsWith("ui://"))
  )
    throw new McpError(
      "UI resourceUri must use ui://",
      undefined,
      McpErrorCode.InvalidParams,
    );
  if (
    metadata.visibility !== undefined &&
    (!Array.isArray(metadata.visibility) ||
      !metadata.visibility.every(
        (entry) => entry === "model" || entry === "app",
      ))
  )
    throw new McpError(
      "invalid UI visibility",
      undefined,
      McpErrorCode.InvalidParams,
    );
  return metadata as McpUiToolMeta;
}
