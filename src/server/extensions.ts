import type { createTaskRuntime } from "../extensions/tasks/index.js";
import type { createSkillPublisher } from "../extensions/skills/index.js";
import type { InputResponses } from "../protocol/types.js";
import { McpError } from "../protocol/index.js";
import type { McpProviders, McpRequestContext } from "./contracts.js";

const identity = (context: McpRequestContext) => {
  if (!context.identity)
    throw new McpError(
      "Authenticated extension identity required",
      401,
      -32602,
    );
  return context.identity;
};

/** Runtime owns durable state and input authorization; server owns wire validation. */
export function createTaskProviders(
  runtime: ReturnType<typeof createTaskRuntime>,
): McpProviders {
  return {
    "tasks/get": {
      resource: "mcp:tasks",
      action: "read",
      handle: (params, context) =>
        runtime.get(identity(context), String(params.taskId)),
    },
    "tasks/update": {
      resource: "mcp:tasks",
      action: "update",
      handle: (params, context) =>
        runtime.submitInput(
          identity(context),
          String(params.taskId),
          params.inputResponses as InputResponses,
        ),
    },
    "tasks/cancel": {
      resource: "mcp:tasks",
      action: "cancel",
      handle: (params, context) =>
        runtime.cancel(identity(context), String(params.taskId)),
    },
  };
}

/** Host explicitly chooses the resource authorization domain for this snapshot. */
export function createSkillProviders(
  publisher: Awaited<ReturnType<typeof createSkillPublisher>>,
  resource: string,
): McpProviders {
  const noCursor = (params: Record<string, unknown>) => {
    if (params.cursor !== undefined)
      throw new McpError("Unknown cursor", 400, -32602);
  };
  return {
    "skills/list": {
      resource,
      action: "read",
      handle: (params) => {
        noCursor(params);
        return publisher.list();
      },
    },
    "skills/get": {
      resource,
      action: "read",
      handle: (params) => publisher.get(String(params.uri)),
    },
    "resources/read": {
      resource,
      action: "read",
      handle: (params) => publisher.read(String(params.uri)),
    },
    "resources/directory/read": {
      resource,
      action: "read",
      handle: (params) => {
        noCursor(params);
        return publisher.directoryRead(String(params.uri));
      },
    },
  };
}
