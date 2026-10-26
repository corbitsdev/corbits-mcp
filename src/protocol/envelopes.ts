import { type } from "arktype";
import { McpError, McpErrorCode } from "./errors.js";
import { assertJsonBounds } from "./json-schema.js";
import type { RequestId } from "./types.js";
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: RequestId;
  method: string;
  params?: Record<string, unknown>;
}
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}
const EnvelopeSchema = type({
  jsonrpc: "'2.0'",
  method: "string",
  "params?": "Record<string, unknown>",
  "id?": "string | number",
});
export function validateJsonRpcRequest(value: unknown): JsonRpcRequest;
export function validateJsonRpcRequest(
  value: unknown,
  allowNotification: true,
): JsonRpcRequest | JsonRpcNotification;
export function validateJsonRpcRequest(
  value: unknown,
  allowNotification = false,
): JsonRpcRequest | JsonRpcNotification {
  assertJsonBounds(value);
  const parsed = EnvelopeSchema(value);
  if (
    parsed instanceof type.errors ||
    Array.isArray(parsed.params) ||
    Object.hasOwn(parsed, "result") ||
    Object.hasOwn(parsed, "error") ||
    (!allowNotification && !Object.hasOwn(parsed, "id")) ||
    (typeof parsed.id === "number" && !Number.isSafeInteger(parsed.id))
  ) {
    throw new McpError(
      "invalid JSON-RPC request envelope",
      400,
      McpErrorCode.InvalidRequest,
    );
  }
  return parsed as JsonRpcRequest | JsonRpcNotification;
}
