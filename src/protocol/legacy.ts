import { type } from "arktype";
import { McpError, McpErrorCode } from "./errors.js";
import { assertJsonBounds } from "./json-schema.js";

/** Lifecycle request shared by the three supported Streamable HTTP revisions. */
const Initialize = type({
  protocolVersion: "string > 0",
  capabilities: "Record<string, unknown>",
  clientInfo: { name: "string", version: "string" },
  "_meta?": "Record<string, unknown>",
});
export function validateLegacyInitialize(
  value: unknown,
): typeof Initialize.infer {
  assertJsonBounds(value);
  const params = Initialize(value);
  if (params instanceof type.errors || Array.isArray(params.capabilities)) {
    throw new McpError(
      "Invalid initialize parameters",
      400,
      McpErrorCode.InvalidParams,
    );
  }
  return params;
}
