import { McpError, McpErrorCode } from "./errors.js";
import { mcpNameFor } from "./methods.js";
import { MCP_PROTOCOL_VERSION, type McpValidationContext } from "./types.js";
export function encodeHeaderValue(value: string): string {
  const plain =
    [...value].every(
      (character) =>
        character === "\t" ||
        (character.charCodeAt(0) >= 0x20 && character.charCodeAt(0) <= 0x7e),
    ) &&
    !/^[ \t]|[ \t]$/.test(value) &&
    !(value.startsWith("=?base64?") && value.endsWith("?="));
  return plain
    ? value
    : `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}
export function decodeHeaderValue(value: string): string {
  if (!(value.startsWith("=?base64?") && value.endsWith("?="))) return value;
  const match = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/.exec(value);
  if (match?.[1] === undefined)
    throw new McpError(
      "invalid encoded MCP header",
      400,
      McpErrorCode.HeaderMismatch,
    );
  const bytes = Buffer.from(match[1], "base64");
  if (bytes.toString("base64") !== match[1])
    throw new McpError(
      "invalid base64 MCP header",
      400,
      McpErrorCode.HeaderMismatch,
    );
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new McpError(
      "invalid UTF-8 MCP header",
      400,
      McpErrorCode.HeaderMismatch,
    );
  }
}
export type HeaderSlot = {
  path: string[];
  header: string;
  type: "string" | "integer" | "boolean";
};
/** Throws for annotations that cannot be statically resolved through properties. */
export function collectHeaderSlots(
  schema: Record<string, unknown>,
): HeaderSlot[] {
  const slots: HeaderSlot[] = [];
  const seen = new Set<string>();
  let nodes = 0;
  const walk = (
    node: unknown,
    path: string[],
    reachable: boolean,
    depth: number,
  ): void => {
    if (++nodes > 10_000 || depth > 64)
      throw new McpError("header schema complexity limit exceeded");
    if (typeof node !== "object" || node === null) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, path, false, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    if (Object.hasOwn(record, "x-mcp-header")) {
      const header = record["x-mcp-header"];
      const kind = record.type;
      if (
        !reachable ||
        path.length === 0 ||
        typeof header !== "string" ||
        !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(header) ||
        (kind !== "string" && kind !== "integer" && kind !== "boolean")
      )
        throw new McpError("invalid x-mcp-header annotation");
      if (seen.has(header.toLowerCase()))
        throw new McpError("duplicate x-mcp-header annotation");
      seen.add(header.toLowerCase());
      slots.push({ path, header, type: kind });
    }
    for (const [key, child] of Object.entries(record)) {
      if (
        key === "properties" &&
        typeof child === "object" &&
        child !== null &&
        !Array.isArray(child)
      ) {
        for (const [name, value] of Object.entries(child))
          walk(value, [...path, name], reachable, depth + 1);
      } else if (key !== "x-mcp-header") walk(child, path, false, depth + 1);
    }
  };
  walk(schema, [], true, 0);
  return slots;
}
export function paramHeaders(
  schema: Record<string, unknown> | undefined,
  args: unknown,
  _toolName?: string,
): Record<string, string> {
  if (schema === undefined) return {};
  const headers: Record<string, string> = {};
  for (const slot of collectHeaderSlots(schema)) {
    let value = args;
    for (const key of slot.path)
      value =
        typeof value === "object" && value !== null && Object.hasOwn(value, key)
          ? (value as Record<string, unknown>)[key]
          : undefined;
    if (value === undefined || value === null) continue;
    if (
      slot.type === "integer"
        ? typeof value !== "number" || !Number.isSafeInteger(value)
        : typeof value !== slot.type
    )
      throw new McpError(`invalid header argument ${slot.path.join(".")}`);
    headers[`Mcp-Param-${slot.header}`] = encodeHeaderValue(String(value));
  }
  return headers;
}
export function validateRequestHeaders(
  headers: Headers,
  method: string,
  params: Record<string, unknown>,
  context: McpValidationContext = {},
): void {
  if (context.era === "legacy") return;
  const meta = params._meta as Record<string, unknown> | undefined;
  const version = meta?.["io.modelcontextprotocol/protocolVersion"];
  const fail = (header: string): never => {
    throw new McpError(
      `MCP header mismatch: ${header}`,
      400,
      McpErrorCode.HeaderMismatch,
    );
  };
  if (
    typeof version !== "string" ||
    headers.get("MCP-Protocol-Version") !== version
  )
    fail("MCP-Protocol-Version");
  if (version !== (context.protocolVersion ?? MCP_PROTOCOL_VERSION))
    throw new McpError(
      "unsupported protocol version",
      400,
      McpErrorCode.UnsupportedProtocolVersion,
      { requested: version, supported: [MCP_PROTOCOL_VERSION] },
    );
  if (headers.get("Mcp-Method") !== method) fail("Mcp-Method");
  const name = mcpNameFor(method, params);
  const actual = headers.get("Mcp-Name");
  if (
    name !== undefined &&
    (actual === null || decodeHeaderValue(actual) !== name)
  )
    fail("Mcp-Name");
  if (name === undefined && actual !== null) fail("Mcp-Name");
  const expected = paramHeaders(context.inputSchema, params.arguments);
  for (const [key, value] of Object.entries(expected)) {
    const received = headers.get(key);
    if (
      received === null ||
      decodeHeaderValue(received) !== decodeHeaderValue(value)
    )
      fail(key);
  }
  for (const key of headers.keys())
    if (
      key.startsWith("mcp-param-") &&
      !Object.keys(expected).some((name) => name.toLowerCase() === key)
    )
      fail(key);
}
