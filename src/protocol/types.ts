// Wire contracts derived from MCP 2026-07-28 schema at
// 271ecc9accafdd9b83a3c869fa67c22953b2af80 and the extension pins in extensions.ts.
export const MCP_PROTOCOL_VERSION = "2026-07-28";
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
export type MetaObject = Record<string, unknown>;
export type JsonSchema = boolean | Record<string, unknown>;
export type RequestId = string | number;
export type McpProtocolEra = "modern" | "legacy";
export type McpExtensionSettings = Readonly<
  Record<string, Readonly<Record<string, unknown>>>
>;
export interface McpValidationContext {
  /** Explicit resources/read result payload budget; independently checked, capped at 16 MiB. */
  maxDecodedBytes?: number | undefined;
  era?: McpProtocolEra;
  protocolVersion?: string;
  extensions?: readonly string[] | McpExtensionSettings;
  clientCapabilities?: Record<string, unknown>;
  serverCapabilities?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}
export interface McpRpcError {
  code: number;
  message: string;
  data?: unknown;
}
export interface ElicitRequestFormParams {
  mode?: "form";
  message: string;
  requestedSchema: {
    $schema?: string;
    type: "object";
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
  };
}
export interface ElicitRequestURLParams {
  mode: "url";
  message: string;
  url: string;
}
export type ElicitRequestParams =
  | ElicitRequestFormParams
  | ElicitRequestURLParams;
export interface ElicitRequest {
  method: "elicitation/create";
  params: ElicitRequestParams;
}
export interface ElicitResult {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, string | number | boolean | string[]>;
  _meta?: MetaObject;
}
/** Deprecated input kinds are recognized but not advertised or executed by this package. */
export type InputRequest =
  | ElicitRequest
  | {
      method: "sampling/createMessage" | "roots/list";
      params?: Record<string, unknown>;
    };
export type InputRequests = Record<string, InputRequest>;
export type InputResponses = Record<
  string,
  ElicitResult | Record<string, unknown>
>;
export interface InputRequiredResult {
  resultType: "input_required";
  inputRequests?: InputRequests;
  requestState?: string;
  _meta?: MetaObject;
}
export interface CompleteResult {
  resultType?: "complete";
  _meta?: MetaObject;
  [key: string]: unknown;
}
export type TaskStatus =
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "cancelled";
export interface Task {
  taskId: string;
  status: TaskStatus;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs?: number;
  statusMessage?: string;
}
export type DetailedTask =
  | (Task & { status: "working" | "cancelled" })
  | (Task & { status: "input_required"; inputRequests: InputRequests })
  | (Task & { status: "completed"; result: Record<string, unknown> })
  | (Task & { status: "failed"; error: McpRpcError });
export type CreateTaskResult = Task & {
  resultType: "task";
  _meta?: MetaObject;
};
export type GetTaskResult = DetailedTask & {
  resultType: "complete";
  _meta?: MetaObject;
};
export interface SkillResource {
  uri: string;
  digest: string;
  size: number;
}
export interface Skill {
  uri: string;
  frontmatter: { name: string; description: string; [key: string]: unknown };
  resources: SkillResource[] | "dynamic";
  _meta?: MetaObject;
}
export interface ResourceContents {
  uri: string;
  mimeType?: string;
  _meta?: MetaObject;
}
export interface TextResourceContents extends ResourceContents {
  text: string;
}
export interface BlobResourceContents extends ResourceContents {
  blob: string;
}
export type McpResourceContents = TextResourceContents | BlobResourceContents;
export interface McpUiToolMeta {
  resourceUri?: string;
  visibility?: ("model" | "app")[];
  [key: string]: unknown;
}
export interface McpUiResourceMeta {
  csp?: {
    connectDomains?: string[];
    resourceDomains?: string[];
    frameDomains?: string[];
    baseUriDomains?: string[];
  };
  permissions?: {
    camera?: Record<string, never>;
    microphone?: Record<string, never>;
    geolocation?: Record<string, never>;
    clipboardWrite?: Record<string, never>;
  };
  domain?: string;
  prefersBorder?: boolean;
  [key: string]: unknown;
}
export interface McpPaginationParams {
  cursor?: string;
  _meta?: MetaObject;
}
export interface McpRetryParams {
  inputResponses?: InputResponses;
  requestState?: string;
  _meta?: MetaObject;
}
export interface McpSubscriptionFilter {
  toolsListChanged?: boolean;
  promptsListChanged?: boolean;
  resourcesListChanged?: boolean;
  resourceSubscriptions?: readonly string[];
  taskIds?: readonly string[];
}
export interface McpMethodMap {
  "server/discover": {
    params: { _meta?: MetaObject };
    result: CompleteResult & {
      supportedVersions: string[];
      capabilities: Record<string, unknown>;
    };
  };
  "tools/list": {
    params: McpPaginationParams;
    result: CompleteResult & { tools: Record<string, unknown>[] };
  };
  "tools/call": {
    params: McpRetryParams & {
      name: string;
      arguments?: Record<string, unknown>;
    };
    result: CompleteResult | InputRequiredResult | CreateTaskResult;
  };
  "prompts/list": {
    params: McpPaginationParams;
    result: CompleteResult & { prompts: Record<string, unknown>[] };
  };
  "prompts/get": {
    params: McpRetryParams & {
      name: string;
      arguments?: Record<string, string>;
    };
    result: CompleteResult | InputRequiredResult;
  };
  "resources/list": {
    params: McpPaginationParams;
    result: CompleteResult & { resources: Record<string, unknown>[] };
  };
  "resources/templates/list": {
    params: McpPaginationParams;
    result: CompleteResult & { resourceTemplates: Record<string, unknown>[] };
  };
  "resources/read": {
    params: McpRetryParams & { uri: string };
    result: CompleteResult | InputRequiredResult;
  };
  "completion/complete": {
    params: {
      ref:
        | { type: "ref/prompt"; name: string }
        | { type: "ref/resource"; uri: string };
      argument: { name: string; value: string };
      context?: { arguments?: Record<string, string> };
      _meta?: MetaObject;
    };
    result: CompleteResult & {
      completion: { values: string[]; total?: number; hasMore?: boolean };
    };
  };
  "subscriptions/listen": {
    params: { notifications: McpSubscriptionFilter; _meta?: MetaObject };
    result: CompleteResult;
  };
  "tasks/get": {
    params: { taskId: string; _meta?: MetaObject };
    result: GetTaskResult;
  };
  "tasks/update": {
    params: {
      taskId: string;
      inputResponses: InputResponses;
      _meta?: MetaObject;
    };
    result: CompleteResult;
  };
  "tasks/cancel": {
    params: { taskId: string; _meta?: MetaObject };
    result: CompleteResult;
  };
  "skills/list": {
    params: McpPaginationParams;
    result: CompleteResult & { skills: Skill[] };
  };
  "skills/get": {
    params: { uri: string; _meta?: MetaObject };
    result: CompleteResult & { skill: Skill };
  };
  "resources/directory/read": {
    params: McpPaginationParams & { uri: string };
    result: CompleteResult & { resources: Record<string, unknown>[] };
  };
}
export type McpMethod = keyof McpMethodMap;
