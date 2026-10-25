import { type } from "arktype";
import { validateContentBlock, validateResourceContents } from "./content.js";
import { validateUiToolMeta } from "./ui.js";
import { McpError, McpErrorCode } from "./errors.js";
import {
  extensionEnabled,
  MCP_EXT_TASKS,
  MCP_EXT_SKILLS,
} from "./extensions.js";
import { methodDescriptor } from "./methods.js";
import {
  assertJsonBounds,
  assertResourceJsonBounds,
  validateInstance,
  validateSchema,
} from "./json-schema.js";
import {
  MCP_PROTOCOL_VERSION,
  type McpValidationContext,
  type Skill,
  type Task,
  type DetailedTask,
} from "./types.js";

export const McpToolSchema = type({
  name: "string",
  "title?": "string",
  "description?": "string",
  inputSchema: "Record<string, unknown>",
  "outputSchema?": "Record<string, unknown>",
  "annotations?": {
    "title?": "string",
    "readOnlyHint?": "boolean",
    "destructiveHint?": "boolean",
    "idempotentHint?": "boolean",
    "openWorldHint?": "boolean",
  },
  "icons?": "unknown[]",
  "_meta?": "Record<string, unknown>",
});
export type McpTool = typeof McpToolSchema.infer;
export const PromptSchema = type({
  name: "string",
  "title?": "string",
  "description?": "string",
  "arguments?": type({
    name: "string",
    "description?": "string",
    "required?": "boolean",
  }).array(),
  "icons?": "unknown[]",
  "_meta?": "Record<string, unknown>",
});
export const ResourceSchema = type({
  uri: "string",
  name: "string",
  "title?": "string",
  "description?": "string",
  "mimeType?": "string",
  "size?": "number",
  "annotations?": "Record<string, unknown>",
  "icons?": "unknown[]",
  "_meta?": "Record<string, unknown>",
});
export const TemplateSchema = type({
  uriTemplate: "string",
  name: "string",
  "title?": "string",
  "description?": "string",
  "mimeType?": "string",
  "annotations?": "Record<string, unknown>",
  "icons?": "unknown[]",
  "_meta?": "Record<string, unknown>",
});
export const SkillSchema = type({
  uri: "string",
  frontmatter: { name: "string", description: "string", "[string]": "unknown" },
  resources: "unknown",
  "_meta?": "Record<string, unknown>",
});
export const TaskHandleSchema = type({
  taskId: "string",
  status: "'working' | 'input_required' | 'completed' | 'failed' | 'cancelled'",
  createdAt: "string",
  lastUpdatedAt: "string",
  ttlMs: "number | null",
  "pollIntervalMs?": "number",
  "statusMessage?": "string",
  "_meta?": "Record<string, unknown>",
});
export const ToolCallResult = type({
  content: "unknown",
  "isError?": "boolean",
  "structuredContent?": "unknown",
  "_meta?": "Record<string, unknown>",
});
export const PromptResult = type({
  "description?": "string",
  messages: "unknown[]",
  "_meta?": "Record<string, unknown>",
});
export const CompletionResult = type({
  completion: { values: "string[]", "total?": "number", "hasMore?": "boolean" },
});
export const DiscoverResult = type({
  supportedVersions: "string[]",
  capabilities: "Record<string, unknown>",
  "instructions?": "string",
  "_meta?": "Record<string, unknown>",
});
export const JsonRpcResponse = type({
  jsonrpc: "'2.0'",
  id: "string | number | null",
  "result?": "unknown",
  "error?": { code: "number", message: "string", "data?": "unknown" },
});

function invalid(
  message: string,
  code: number = McpErrorCode.InvalidParams,
): never {
  throw new McpError(message, undefined, code);
}
export function record(
  value: unknown,
  label = "value",
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function check(
  validator: (value: unknown) => unknown,
  value: unknown,
  label: string,
): void {
  const parsed = validator(value);
  if (parsed instanceof type.errors)
    invalid(`malformed ${label}: ${parsed.summary}`);
}
function string(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") invalid(`${label} must be a string`);
}
function integer(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    invalid(`${label} must be a nonnegative safe integer`);
}
function meta(value: Record<string, unknown>): void {
  if (value._meta !== undefined) record(value._meta, "_meta");
}
function list(
  value: unknown,
  label: string,
  validate: (value: unknown) => void,
): void {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  for (const item of value) validate(item);
}
/** Tokens are protocol integers (not fractional progress values) or strings. */
export function validateProgressToken(
  value: unknown,
): asserts value is string | number {
  if (
    typeof value !== "string" &&
    !(typeof value === "number" && Number.isSafeInteger(value))
  )
    invalid("invalid progress token");
}

// Restricted elicitation union, not arbitrary JSON Schema. Reference:
// specification@271ecc9accafdd9b83a3c869fa67c22953b2af80/schema/2026-07-28/schema.ts
const elicitationAnnotations = {
  "title?": "string",
  "description?": "string",
} as const;
const enumOption = type({ const: "string", title: "string" }).onUndeclaredKey(
  "reject",
);
const elicitationProperty = type({
  ...elicitationAnnotations,
  type: "'string'",
  "default?": "string",
  "minLength?": "number",
  "maxLength?": "number",
  "format?": "'email' | 'uri' | 'date' | 'date-time'",
})
  .onUndeclaredKey("reject")
  .or(
    type({
      ...elicitationAnnotations,
      type: "'number' | 'integer'",
      "default?": "number",
      "minimum?": "number",
      "maximum?": "number",
    }).onUndeclaredKey("reject"),
  )
  .or(
    type({
      ...elicitationAnnotations,
      type: "'boolean'",
      "default?": "boolean",
    }).onUndeclaredKey("reject"),
  )
  .or(
    type({
      ...elicitationAnnotations,
      type: "'string'",
      enum: "string[]",
      "enumNames?": "string[]",
      "default?": "string",
    }).onUndeclaredKey("reject"),
  )
  .or(
    type({
      ...elicitationAnnotations,
      type: "'string'",
      oneOf: enumOption.array(),
      "default?": "string",
    }).onUndeclaredKey("reject"),
  )
  .or(
    type({
      ...elicitationAnnotations,
      type: "'array'",
      "minItems?": "number",
      "maxItems?": "number",
      "default?": "string[]",
      items: type({ type: "'string'", enum: "string[]" })
        .onUndeclaredKey("reject")
        .or(type({ anyOf: enumOption.array() }).onUndeclaredKey("reject")),
    }).onUndeclaredKey("reject"),
  );

export function validateInputRequests(
  value: unknown,
  context: McpValidationContext = {},
): void {
  for (const input of Object.values(record(value, "inputRequests"))) {
    const request = record(input, "input request");
    if (
      request.method === "sampling/createMessage" ||
      request.method === "roots/list"
    )
      invalid(
        `unsupported input capability ${String(request.method)}`,
        McpErrorCode.MissingRequiredClientCapability,
      );
    if (request.method !== "elicitation/create")
      invalid("unsupported input request method");
    const params = record(request.params, "elicitation params");
    string(params.message, "elicitation message");
    if (params.mode === "url") {
      string(params.url, "elicitation URL");
      try {
        const url = new URL(params.url);
        if (url.protocol !== "https:" && url.protocol !== "http:")
          invalid("unsupported elicitation URL scheme");
      } catch {
        invalid("invalid elicitation URL");
      }
    } else if (params.mode === undefined || params.mode === "form") {
      const schema = record(params.requestedSchema, "requestedSchema");
      if (schema.type !== "object")
        invalid("elicitation schema must be an object schema");
      for (const property of Object.values(
        record(schema.properties, "elicitation properties"),
      )) {
        check(elicitationProperty, property, "elicitation property");
      }
      validateSchema(schema);
    } else invalid("unsupported elicitation mode");
    if (context.clientCapabilities !== undefined) {
      const capability = record(
        context.clientCapabilities.elicitation ?? {},
        "elicitation capability",
      );
      const mode = params.mode ?? "form";
      const legacyForm =
        context.clientCapabilities.elicitation !== undefined &&
        Object.keys(capability).length === 0 &&
        mode === "form";
      if (!legacyForm && !Object.hasOwn(capability, String(mode)))
        invalid(
          `missing elicitation ${String(mode)} capability`,
          McpErrorCode.MissingRequiredClientCapability,
        );
    }
  }
}
export function validateInputResponses(value: unknown): void {
  for (const response of Object.values(record(value, "inputResponses"))) {
    const input = record(response, "input response");
    if (
      input.action !== "accept" &&
      input.action !== "decline" &&
      input.action !== "cancel"
    )
      invalid("invalid elicitation action");
    if (input.content !== undefined)
      for (const field of Object.values(record(input.content))) {
        if (
          typeof field !== "string" &&
          typeof field !== "number" &&
          typeof field !== "boolean" &&
          !(
            Array.isArray(field) &&
            field.every((item) => typeof item === "string")
          )
        )
          invalid("invalid elicitation content");
      }
  }
}
export function validateTask(
  value: unknown,
  detailed = false,
  context: McpValidationContext = {},
): Task | DetailedTask {
  check(TaskHandleSchema, value, "task");
  const task = record(value);
  for (const field of ["createdAt", "lastUpdatedAt"])
    if (
      typeof task[field] !== "string" ||
      !/^\d{4}-\d\d-\d\dT/.test(task[field]) ||
      !Number.isFinite(Date.parse(task[field]))
    )
      invalid(`invalid task ${field}`);
  if (task.ttlMs !== null) integer(task.ttlMs, "task ttlMs");
  if (task.pollIntervalMs !== undefined)
    integer(task.pollIntervalMs, "task pollIntervalMs");
  if (detailed) {
    if (task.status === "input_required")
      validateInputRequests(task.inputRequests, context);
    if (task.status === "completed") {
      const result = record(task.result, "completed task result");
      if (result.resultType !== undefined && result.resultType !== "complete")
        invalid("completed task requires a final complete result");
      validateResult("tools/call", result, context);
    }
    if (task.status === "failed")
      check(
        type({ code: "number", message: "string", "data?": "unknown" }),
        task.error,
        "task error",
      );
  }
  return value as Task | DetailedTask;
}
export function validateSkill(value: unknown): Skill {
  check(SkillSchema, value, "skill");
  const skill = record(value);
  if (skill.resources !== "dynamic") {
    const uris = new Set<string>();
    list(skill.resources, "skill resources", (item) => {
      const resource = record(item);
      string(resource.uri, "skill resource URI");
      string(resource.digest, "skill digest");
      integer(resource.size, "skill size");
      if (!/^sha256:[a-f0-9]{64}$/.test(resource.digest))
        invalid("invalid skill digest");
      if (uris.has(resource.uri)) invalid("duplicate skill resource URI");
      uris.add(resource.uri);
    });
    if (!uris.has(String(skill.uri))) invalid("skill manifest omits SKILL.md");
  }
  return value as Skill;
}
function eligibility(method: string, context: McpValidationContext): void {
  const descriptor = methodDescriptor(method);
  if (descriptor === undefined)
    invalid(`unknown method ${method}`, McpErrorCode.MethodNotFound);
  if (
    descriptor.extension !== undefined &&
    (context.era === "legacy" ||
      !extensionEnabled(context, descriptor.extension))
  )
    invalid(`extension ${descriptor.extension} is not enabled`);
  if (
    context.serverCapabilities !== undefined &&
    descriptor.capability !== undefined &&
    !Object.hasOwn(context.serverCapabilities, descriptor.capability)
  )
    invalid(
      `server does not advertise ${descriptor.capability}`,
      McpErrorCode.MethodNotFound,
    );
}
export function validateRequest(
  method: string,
  value: unknown,
  context: McpValidationContext = {},
): Record<string, unknown> {
  eligibility(method, context);
  const params = record(value ?? {}, "params");
  assertJsonBounds(params);
  meta(params);
  if (params._meta !== undefined) {
    const metadata = record(params._meta);
    if (Object.hasOwn(metadata, "progressToken"))
      validateProgressToken(metadata.progressToken);
  }
  if (context.era !== "legacy") {
    const metadata = record(params._meta, "request _meta");
    const version = metadata["io.modelcontextprotocol/protocolVersion"];
    if (version !== (context.protocolVersion ?? MCP_PROTOCOL_VERSION))
      invalid(
        "unsupported protocol version",
        McpErrorCode.UnsupportedProtocolVersion,
      );
    record(
      metadata["io.modelcontextprotocol/clientCapabilities"],
      "clientCapabilities",
    );
  }
  if (params.cursor !== undefined) string(params.cursor, "cursor");
  if (params.requestState !== undefined)
    string(params.requestState, "requestState");
  if (params.inputResponses !== undefined) {
    if (!methodDescriptor(method)?.inputRequired && method !== "tasks/update")
      invalid(`inputResponses not allowed for ${method}`);
    validateInputResponses(params.inputResponses);
  }
  if (
    context.era === "legacy" &&
    (params.inputResponses !== undefined || params.requestState !== undefined)
  )
    invalid("MRTR is not available on legacy protocol");
  if (["tools/call", "prompts/get"].includes(method))
    string(params.name, "name");
  if (
    ["resources/read", "skills/get", "resources/directory/read"].includes(
      method,
    )
  )
    string(params.uri, "uri");
  if (method.startsWith("tasks/")) string(params.taskId, "taskId");
  if (method === "tasks/update") validateInputResponses(params.inputResponses);
  if (method === "tools/call") {
    if (params.arguments !== undefined) record(params.arguments, "arguments");
    if (context.inputSchema !== undefined)
      validateInstance(context.inputSchema, params.arguments ?? {});
  }
  if (method === "prompts/get" && params.arguments !== undefined)
    for (const arg of Object.values(record(params.arguments)))
      string(arg, "prompt argument");
  if (method === "completion/complete") {
    const ref = record(params.ref);
    if (ref.type === "ref/prompt") string(ref.name, "ref name");
    else if (ref.type === "ref/resource") string(ref.uri, "ref URI");
    else invalid("invalid completion ref");
    const argument = record(params.argument);
    string(argument.name, "argument name");
    string(argument.value, "argument value");
  }
  if (method === "subscriptions/listen")
    validateFilter(params.notifications, context);
  if (method === "resources/directory/read") {
    const extensions = record(
      context.serverCapabilities?.extensions ?? {},
      "server extensions",
    );
    if (record(extensions[MCP_EXT_SKILLS] ?? {}).directoryRead !== true)
      invalid("server does not advertise directoryRead");
  }
  if (
    method.startsWith("skills/") &&
    context.serverCapabilities !== undefined &&
    !Object.hasOwn(
      record(context.serverCapabilities.extensions ?? {}),
      MCP_EXT_SKILLS,
    )
  )
    invalid("server does not advertise skills");
  return params;
}
function validateFilter(value: unknown, context: McpValidationContext): void {
  const filter = record(value, "notifications");
  for (const key of [
    "toolsListChanged",
    "promptsListChanged",
    "resourcesListChanged",
  ])
    if (filter[key] !== undefined && typeof filter[key] !== "boolean")
      invalid(`invalid ${key}`);
  for (const key of ["resourceSubscriptions", "taskIds"])
    if (filter[key] !== undefined)
      list(filter[key], key, (item) => string(item, key));
  if (filter.taskIds !== undefined && !extensionEnabled(context, MCP_EXT_TASKS))
    invalid("tasks extension is not enabled");
}
export function validateResult(
  method: string,
  value: unknown,
  context: McpValidationContext = {},
): Record<string, unknown> {
  eligibility(method, context);
  const result = record(value, "result");
  if (method === "resources/read" && context.maxDecodedBytes !== undefined)
    assertResourceJsonBounds(result, context.maxDecodedBytes);
  else assertJsonBounds(result);
  meta(result);
  const kind = result.resultType === undefined ? "complete" : result.resultType;
  const descriptor = methodDescriptor(method);
  if (kind !== "complete" && kind !== "input_required" && kind !== "task")
    invalid(`unrecognized resultType for ${method}`);
  if (kind !== "complete" && context.era === "legacy")
    invalid("polymorphic result on legacy protocol");
  if (kind === "task") {
    if (!extensionEnabled(context, MCP_EXT_TASKS))
      invalid("tasks extension is not enabled");
    if (!descriptor?.task) invalid(`task result is not allowed for ${method}`);
    validateTask(result, false, context);
    return result;
  }
  if (kind === "input_required") {
    if (!descriptor?.inputRequired)
      invalid(`input_required is not allowed for ${method}`);
    if (result.inputRequests === undefined && result.requestState === undefined)
      invalid("input_required requires inputRequests or requestState");
    if (result.requestState !== undefined)
      string(result.requestState, "requestState");
    if (result.inputRequests !== undefined)
      validateInputRequests(result.inputRequests, context);
    return result;
  }
  if (
    method !== "tasks/get" &&
    result.ttlMs !== undefined &&
    (typeof result.ttlMs !== "number" || !Number.isFinite(result.ttlMs))
  )
    invalid("invalid ttlMs");
  if (
    result.cacheScope !== undefined &&
    result.cacheScope !== "public" &&
    result.cacheScope !== "private"
  )
    invalid("invalid cacheScope");
  if (result.nextCursor !== undefined) string(result.nextCursor, "nextCursor");
  switch (method) {
    case "server/discover":
      check(DiscoverResult, result, method);
      break;
    case "tools/list":
      list(result.tools, "tools", (tool) => {
        check(McpToolSchema, tool, "tool");
        const entry = record(tool);
        validateSchema(entry.inputSchema);
        if (record(entry.inputSchema).type !== "object")
          invalid("tool inputSchema must have type object");
        if (entry._meta !== undefined) {
          const metadata = record(entry._meta);
          if (metadata.ui !== undefined) validateUiToolMeta(metadata.ui);
        }
        if (entry.outputSchema !== undefined)
          validateSchema(entry.outputSchema);
      });
      break;
    case "prompts/list":
      list(result.prompts, "prompts", (prompt) =>
        check(PromptSchema, prompt, "prompt"),
      );
      break;
    case "resources/list":
    case "resources/directory/read":
      list(result.resources, "resources", (resource) =>
        check(ResourceSchema, resource, "resource"),
      );
      break;
    case "resources/templates/list":
      list(result.resourceTemplates, "resourceTemplates", (template) =>
        check(TemplateSchema, template, "resource template"),
      );
      break;
    case "tools/call":
      check(ToolCallResult, result, method);
      list(result.content, "tool content", (block) => {
        validateContentBlock(block);
      });
      if (context.outputSchema !== undefined && result.isError !== true)
        validateInstance(context.outputSchema, result.structuredContent);
      break;
    case "prompts/get":
      check(PromptResult, result, method);
      list(result.messages, "prompt messages", (value) => {
        const message = record(value);
        if (message.role !== "user" && message.role !== "assistant")
          invalid("invalid prompt message role");
        validateContentBlock(message.content);
      });
      break;
    case "resources/read":
      list(result.contents, "contents", (item) => {
        validateResourceContents(item);
      });
      break;
    case "completion/complete":
      check(CompletionResult, result, method);
      if ((record(result.completion).values as unknown[]).length > 100)
        invalid("too many completion values");
      break;
    case "tasks/get":
      validateTask(result, true, context);
      break;
    case "skills/list":
      list(result.skills, "skills", (skill) => {
        validateSkill(skill);
      });
      break;
    case "skills/get":
      validateSkill(result.skill);
      break;
  }
  return result;
}
export function validateNotification(
  method: string,
  value: unknown,
  context: McpValidationContext = {},
): Record<string, unknown> {
  const params = record(value ?? {}, "notification params");
  assertJsonBounds(params);
  meta(params);
  switch (method) {
    case "notifications/progress":
      validateProgressToken(params.progressToken);
      if (
        typeof params.progress !== "number" ||
        !Number.isFinite(params.progress)
      )
        invalid("invalid progress");
      if (
        params.total !== undefined &&
        (typeof params.total !== "number" || !Number.isFinite(params.total))
      )
        invalid("invalid progress total");
      if (params.message !== undefined)
        string(params.message, "progress message");
      break;
    case "notifications/cancelled":
      if (
        typeof params.requestId !== "string" &&
        typeof params.requestId !== "number"
      )
        invalid("invalid cancelled requestId");
      break;
    case "notifications/tasks":
      if (!extensionEnabled(context, MCP_EXT_TASKS))
        invalid("tasks extension is not enabled");
      validateTask(params, true, context);
      break;
    case "notifications/subscriptions/acknowledged":
      validateFilter(params.notifications, context);
      break;
    case "notifications/resources/updated":
      string(params.uri, "resource URI");
      break;
    case "notifications/tools/list_changed":
    case "notifications/prompts/list_changed":
    case "notifications/resources/list_changed":
      break;
    case "notifications/initialized":
      if (context.era !== "legacy") invalid("initialized is legacy only");
      break;
    default:
      invalid(
        `unsupported notification ${method}`,
        McpErrorCode.MethodNotFound,
      );
  }
  return params;
}
