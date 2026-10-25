import { type } from "arktype";
import { McpError, McpErrorCode } from "./errors.js";
import { assertJsonBounds } from "./json-schema.js";
import type { McpResourceContents, MetaObject } from "./types.js";
export type ContentBlock =
  | {
      type: "text";
      text: string;
      annotations?: ContentAnnotations;
      _meta?: MetaObject;
    }
  | {
      type: "image" | "audio";
      data: string;
      mimeType: string;
      annotations?: ContentAnnotations;
      _meta?: MetaObject;
    }
  | {
      type: "resource";
      resource: McpResourceContents;
      annotations?: ContentAnnotations;
      _meta?: MetaObject;
    }
  | {
      type: "resource_link";
      uri: string;
      name: string;
      title?: string;
      description?: string;
      mimeType?: string;
      size?: number;
      annotations?: ContentAnnotations;
      _meta?: MetaObject;
    };
export interface ContentAnnotations {
  audience?: ("user" | "assistant")[];
  priority?: number;
  lastModified?: string;
}
const AnnotationsSchema = type({
  "audience?": "('user' | 'assistant')[]",
  "priority?": "number",
  "lastModified?": "string",
});
const ResourceContentsSchema = type({
  uri: "string",
  "mimeType?": "string",
  "text?": "string",
  "blob?": "string",
  "_meta?": "Record<string, unknown>",
});
export function validateResourceContents(value: unknown): McpResourceContents {
  const parsed = ResourceContentsSchema(value);
  if (
    parsed instanceof type.errors ||
    (typeof parsed.text !== "string" && typeof parsed.blob !== "string") ||
    (parsed.text !== undefined && parsed.blob !== undefined)
  )
    throw new McpError(
      "invalid resource contents",
      undefined,
      McpErrorCode.InvalidParams,
    );
  return parsed as McpResourceContents;
}
export function validateContentBlock(value: unknown): ContentBlock {
  assertJsonBounds(value);
  const base = type({
    type: "string",
    "annotations?": AnnotationsSchema,
    "_meta?": "Record<string, unknown>",
  })(value);
  if (base instanceof type.errors)
    throw new McpError(
      "invalid content block",
      undefined,
      McpErrorCode.InvalidParams,
    );
  if (
    base.annotations?.priority !== undefined &&
    (base.annotations.priority < 0 || base.annotations.priority > 1)
  )
    throw new McpError(
      "invalid content priority",
      undefined,
      McpErrorCode.InvalidParams,
    );
  let parsed: unknown;
  switch (base.type) {
    case "text":
      parsed = type({ text: "string" })(value);
      break;
    case "image":
    case "audio":
      parsed = type({ data: "string", mimeType: "string" })(value);
      break;
    case "resource":
      validateResourceContents((value as { resource?: unknown }).resource);
      return value as ContentBlock;
    case "resource_link":
      parsed = type({
        uri: "string",
        name: "string",
        "title?": "string",
        "description?": "string",
        "mimeType?": "string",
        "size?": "number",
      })(value);
      break;
    default:
      throw new McpError(
        "unknown content block type",
        undefined,
        McpErrorCode.InvalidParams,
      );
  }
  if (parsed instanceof type.errors)
    throw new McpError(
      `invalid ${base.type} content block`,
      undefined,
      McpErrorCode.InvalidParams,
    );
  return value as ContentBlock;
}
