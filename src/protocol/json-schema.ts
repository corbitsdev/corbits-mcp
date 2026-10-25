import { Ajv2020 } from "ajv/dist/2020.js";
import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";
import { McpError, McpErrorCode } from "./errors.js";
import type { JsonSchema } from "./types.js";

const options = {
  strict: false,
  allErrors: false,
  validateFormats: false,
  addUsedSchema: false,
  ownProperties: true,
  code: { optimize: false },
  loopRequired: 100,
  loopEnum: 100,
} as const;
const modern = new Ajv2020(options);
const draft7 = new Ajv(options);
const cache = new Map<string, ValidateFunction>();
/** Limits apply before AJV compilation and before data validation. No network resolver is installed. */
export function assertJsonBounds(value: unknown, schema = false): void {
  assertBounds(value, schema);
}

/** Resource payloads alone get an explicit allowance; metadata and JSON structure
 * remain bounded. */
export function assertResourceJsonBounds(
  value: unknown,
  maxDecodedBytes: number,
): void {
  if (!Number.isSafeInteger(maxDecodedBytes) || maxDecodedBytes < 0)
    throw new McpError("maxDecodedBytes must be a nonnegative safe integer");
  assertBounds(value, false, Math.min(maxDecodedBytes, 16 * 1024 * 1024));
}

function assertBounds(
  value: unknown,
  schema: boolean,
  resourceBytes?: number,
): void {
  let nodes = 0;
  let bytes = 0;
  let decodedBytes = 0;
  const active = new Set<object>();
  const visit = (item: unknown, depth: number, path: string[]): void => {
    if (++nodes > (schema ? 10_000 : 100_000) || depth > 64)
      throw new McpError("JSON complexity limit exceeded");
    if (typeof item === "string") {
      const payloadPath = path;
      const payload =
        resourceBytes !== undefined &&
        payloadPath.length === 3 &&
        payloadPath[0] === "contents" &&
        payloadPath[1] === "*" &&
        (payloadPath[2] === "text" || payloadPath[2] === "blob");
      if (payload) {
        decodedBytes +=
          payloadPath[2] === "text"
            ? Buffer.byteLength(item)
            : Math.max(
                0,
                Math.floor((item.length * 3) / 4) -
                  (item.endsWith("==") ? 2 : item.endsWith("=") ? 1 : 0),
              );
        if (decodedBytes > resourceBytes!)
          throw new McpError("Resource decoded byte limit exceeded");
        bytes += 2; // JSON string delimiters, not payload encoding
      } else {
        bytes += Buffer.byteLength(item);
        if (resourceBytes !== undefined) {
          if (bytes > 64 * 1024)
            throw new McpError(
              "Resource metadata/envelope byte limit exceeded",
            );
          bytes +=
            Buffer.byteLength(JSON.stringify(item)) - Buffer.byteLength(item);
        }
      }
    } else if (typeof item === "number" && !Number.isFinite(item))
      throw new McpError("JSON numbers must be finite");
    else if (typeof item === "object" && item !== null) {
      if (active.has(item)) throw new McpError("cyclic JSON value");
      active.add(item);
      if (resourceBytes !== undefined) bytes += 2; // braces/brackets
      let first = true;
      for (const [key, child] of Object.entries(item)) {
        if (resourceBytes === undefined) bytes += Buffer.byteLength(key);
        else {
          if (!first) bytes++;
          if (!Array.isArray(item)) {
            if (Buffer.byteLength(key) > 64 * 1024)
              throw new McpError(
                "Resource metadata/envelope byte limit exceeded",
              );
            bytes += Buffer.byteLength(JSON.stringify(key)) + 1;
          }
        }
        first = false;
        visit(child, depth + 1, [...path, Array.isArray(item) ? "*" : key]);
      }
      active.delete(item);
    } else if (
      item !== null &&
      typeof item !== "boolean" &&
      typeof item !== "number"
    )
      throw new McpError("non-JSON value");
    if (resourceBytes !== undefined) {
      if (
        item === null ||
        typeof item === "boolean" ||
        typeof item === "number"
      )
        bytes += String(item).length;
      if (bytes > 64 * 1024)
        throw new McpError("Resource metadata/envelope byte limit exceeded");
    }
    if (
      resourceBytes === undefined &&
      bytes > (schema ? 256 * 1024 : 4 * 1024 * 1024)
    )
      throw new McpError("JSON byte limit exceeded");
  };
  visit(value, 0, []);
}
function compile(schema: unknown): ValidateFunction {
  assertJsonBounds(schema, true);
  if (
    typeof schema !== "boolean" &&
    (typeof schema !== "object" || schema === null || Array.isArray(schema))
  )
    throw new McpError("JSON Schema must be an object or boolean");
  const key = JSON.stringify(schema);
  const existing = cache.get(key);
  if (existing !== undefined) return existing;
  const dialect =
    typeof schema === "object" && schema !== null
      ? (schema as Record<string, unknown>).$schema
      : undefined;
  const validator =
    dialect === undefined ||
    dialect === "https://json-schema.org/draft/2020-12/schema"
      ? modern
      : dialect === "http://json-schema.org/draft-07/schema#" ||
          dialect === "http://json-schema.org/draft-07/schema"
        ? draft7
        : undefined;
  if (validator === undefined)
    throw new McpError(`unsupported JSON Schema dialect ${String(dialect)}`);
  try {
    // Compile an immutable snapshot: caller mutation cannot change a cached validator.
    const result = validator.compile(JSON.parse(key) as JsonSchema);
    if (cache.size >= 128) {
      const first = cache.keys().next().value;
      if (first !== undefined) cache.delete(first);
    }
    cache.set(key, result);
    return result;
  } catch (cause) {
    throw new McpError(
      `invalid JSON Schema: ${cause instanceof Error ? cause.message : String(cause)}`,
      undefined,
      McpErrorCode.InvalidParams,
    );
  }
}
export function validateSchema(schema: unknown): JsonSchema {
  compile(schema);
  return schema as JsonSchema;
}
export function validateInstance(schema: unknown, value: unknown): void {
  assertJsonBounds(value);
  const validator = compile(schema);
  if (!validator(value))
    throw new McpError(
      `JSON Schema instance validation failed: ${modern.errorsText(validator.errors)}`,
      undefined,
      McpErrorCode.InvalidParams,
    );
}
