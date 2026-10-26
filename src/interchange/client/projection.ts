import { createElicitationRuntime } from "../../extensions/elicitation.js";
import {
  validateInputRequests,
  type InputRequests,
} from "../../protocol/index.js";
import type { ToolResult } from "@intx/types/runtime";
import { type } from "arktype";
import {
  mcpContinue,
  mcpGetTask,
  mcpUpdateTask,
  mcpCancelTask,
  type McpClientOptions,
  type McpToolCallResult,
} from "../../client.js";
import type { McpHostContext, McpHostServices } from "./contracts.js";

const TextBlocks = type({ type: "'text'", text: "string" }).array();

export function shapeMcpContent(content: unknown): string {
  if (typeof content === "string") return content;
  const blocks = TextBlocks(content);
  if (!(blocks instanceof type.errors))
    return blocks.map((block) => block.text).join("\n");
  return JSON.stringify(content) ?? "";
}

/** One lifecycle and rich-result projection for live and stored catalogs. */
export async function projectToolResult(
  context: McpHostContext,
  initial: McpToolCallResult,
  client: McpClientOptions,
  host: McpHostServices = {},
): Promise<ToolResult> {
  let result = initial;
  // Bound interactive loops independently of individual HTTP request timeouts.
  for (let round = 0; round < 32; round++) {
    context.signal.throwIfAborted();
    if (result.resultType === "input_required") {
      if (host.requestInput === undefined && host.elicitation === undefined)
        return unavailable("unsupported", result);
      if (result.method !== "tools/call")
        throw new Error("MCP tool continuation changed method");
      let responses: Record<string, unknown> | undefined;
      if (host.requestInput !== undefined)
        responses = await host.requestInput(context, result);
      else {
        const requests = result.inputRequests;
        assertInputRequests(requests);
        responses = await createElicitationRuntime(
          host.elicitation ?? {},
        ).respond(requests, context.signal);
      }
      context.signal.throwIfAborted();
      if (responses === undefined) return unavailable("declined", result);
      const next = await mcpContinue(context.url, result, responses, {
        ...client,
        signal: context.signal,
      });
      if (
        next.resultType === "input_required" ||
        next.resultType === "task" ||
        "content" in next
      ) {
        result = next;
        continue;
      }
      throw new Error("MCP tool continuation returned a non-tool result");
    }
    if (result.resultType === "task") {
      if (host.adoptTask === undefined)
        return unavailable("unsupported", result);
      const taskId = result.taskId;
      // Do not retain the original invocation signal for the task's lifetime.
      const { signal: _signal, ...taskClient } = client;
      const adopted = await host.adoptTask(context, result, {
        get: () => mcpGetTask(context.url, taskId, taskClient),
        update: (responses) =>
          mcpUpdateTask(context.url, taskId, responses, taskClient),
        cancel: () => mcpCancelTask(context.url, taskId, taskClient),
      });
      if (adopted.correlationId.trim().length === 0)
        throw new Error("MCP task host returned an empty correlation ID");
      return {
        callId: context.callId,
        content: "Remote MCP task adopted by the host; awaiting its outcome.",
        detail: { mcp: result, outcome: "pending" },
        pendingMarker: {
          status: "pending",
          correlationId: adopted.correlationId,
        },
      };
    }
    await host.presentResult?.(context, result);
    return {
      callId: context.callId,
      isError: result.isError === true,
      content: shapeMcpContent(result.content),
      detail: { mcp: result },
    };
  }
  throw new Error("MCP continuation exceeded 32 input rounds");

  function unavailable(
    outcome: "unsupported" | "declined",
    pending: McpToolCallResult,
  ): ToolResult {
    return {
      callId: context.callId,
      isError: true,
      content: `MCP ${pending.resultType}: host handling ${outcome}.`,
      detail: { mcp: pending, outcome },
    };
  }
}

/** Narrow using the sole shared wire validator, not a second schema. */
function assertInputRequests(value: unknown): asserts value is InputRequests {
  validateInputRequests(value);
}
