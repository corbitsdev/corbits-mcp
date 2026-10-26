import { MCP_EXT_SKILLS, MCP_EXT_TASKS } from "./extensions.js";
import type { McpMethod } from "./types.js";
export interface McpMethodDescriptor {
  capability?: string;
  extension?: string;
  cacheable: boolean;
  inputRequired: boolean;
  task: boolean;
  nameSource?: "name" | "uri" | "taskId";
}
const ordinary = {
  cacheable: false,
  inputRequired: false,
  task: false,
} as const;
export const MCP_METHODS = {
  "server/discover": { ...ordinary, cacheable: true },
  "tools/list": { ...ordinary, capability: "tools", cacheable: true },
  "tools/call": {
    ...ordinary,
    capability: "tools",
    inputRequired: true,
    task: true,
    nameSource: "name",
  },
  "prompts/list": { ...ordinary, capability: "prompts", cacheable: true },
  "prompts/get": {
    ...ordinary,
    capability: "prompts",
    inputRequired: true,
    nameSource: "name",
  },
  "resources/list": { ...ordinary, capability: "resources", cacheable: true },
  "resources/templates/list": {
    ...ordinary,
    capability: "resources",
    cacheable: true,
  },
  "resources/read": {
    ...ordinary,
    capability: "resources",
    cacheable: true,
    inputRequired: true,
    nameSource: "uri",
  },
  "completion/complete": { ...ordinary, capability: "completions" },
  "subscriptions/listen": { ...ordinary, capability: "subscriptions" },
  "tasks/get": { ...ordinary, extension: MCP_EXT_TASKS, nameSource: "taskId" },
  "tasks/update": {
    ...ordinary,
    extension: MCP_EXT_TASKS,
    nameSource: "taskId",
  },
  "tasks/cancel": {
    ...ordinary,
    extension: MCP_EXT_TASKS,
    nameSource: "taskId",
  },
  "skills/list": {
    ...ordinary,
    extension: MCP_EXT_SKILLS,
    capability: "resources",
    cacheable: true,
  },
  "skills/get": {
    ...ordinary,
    extension: MCP_EXT_SKILLS,
    capability: "resources",
    cacheable: true,
  },
  "resources/directory/read": {
    ...ordinary,
    extension: MCP_EXT_SKILLS,
    capability: "resources",
    cacheable: true,
  },
} as const satisfies Record<McpMethod, McpMethodDescriptor>;
export function methodDescriptor(
  method: string,
): McpMethodDescriptor | undefined {
  return Object.hasOwn(MCP_METHODS, method)
    ? MCP_METHODS[method as McpMethod]
    : undefined;
}
export function mcpNameFor(
  method: string,
  params?: Record<string, unknown>,
): string | undefined {
  const source = methodDescriptor(method)?.nameSource;
  const value = source === undefined ? undefined : params?.[source];
  return typeof value === "string" ? value : undefined;
}
