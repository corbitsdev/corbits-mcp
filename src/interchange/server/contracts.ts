import type { Agent, ToolBundle } from "@intx/agent";
import type { ToolResult } from "@intx/types/runtime";
import type { McpIdentity, McpAuthPolicy } from "../../auth/contracts.js";
import type {
  McpOperationOutcome,
  McpRequestContext,
} from "../../server/contracts.js";
import type { McpToolBinding } from "../../server/tools.js";

type BaseExposure = {
  definition: McpToolBinding["definition"];
  tenantId: string;
  resource: string;
  action: string;
  /** Host approval/grant floor. Mandatory even for a bare ToolBundle dispatcher. */
  approve: (
    args: Record<string, unknown>,
    context: McpRequestContext,
  ) => Promise<boolean>;
  /** Host must bind continuations to identity, operation, arguments and one-time state. */
  continue?: (
    params: Record<string, unknown>,
    context: McpRequestContext,
  ) => Promise<McpOperationOutcome>;
};

export type InterchangeToolExposure = BaseExposure & {
  kind: "tool";
  bundle: Pick<ToolBundle, "definitions" | "run">;
  toolName: string;
  /** Explicit mapping for pending markers and full-fidelity detail; no implicit approval. */
  projectResult?: (
    result: ToolResult,
    context: McpRequestContext,
  ) => Promise<McpOperationOutcome>;
};
export type InterchangeAgentExposure = BaseExposure & {
  kind: "agent";
  agent: Pick<Agent, "send">;
  message: (args: Record<string, unknown>) => string;
  suspended: (
    result: Extract<Awaited<ReturnType<Agent["send"]>>, { type: "suspended" }>,
    context: McpRequestContext,
  ) => Promise<McpOperationOutcome>;
};

/** Host-authenticated app pipeline; the adapter never forwards MCP bearer headers. */
export type InterchangeDispatch = (
  request: Request,
  identity: McpIdentity,
) => Promise<Response>;
export type InterchangeHttpExposure = BaseExposure & {
  kind: "operation";
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Fully bound path. No model-controlled tenant, host, path or authorization headers. */
  path: string;
  origin: string;
  dispatch: InterchangeDispatch;
  /** Authored projection, not automatic exposure of OpenAPI or an entire hub. */
  body?: (args: Record<string, unknown>) => Record<string, unknown>;
};
export type WorkflowTrigger = {
  runId: string;
  address: string;
  messageId: string;
};
export type InterchangeWorkflowExposure = BaseExposure & {
  kind: "workflow";
  deploymentId: string;
  origin: string;
  dispatch: InterchangeDispatch;
  message: (args: Record<string, unknown>) => string;
  /** Must durably persist dispatch intent; ambiguous dispatch is never automatically replayed. */
  prepare: (
    args: Record<string, unknown>,
    context: McpRequestContext,
  ) => Promise<string>;
  recordTrigger: (
    intentId: string,
    trigger: WorkflowTrigger,
    context: McpRequestContext,
  ) => Promise<void>;
  /** Select only this message's result, or durably create a task bound to its correlation. */
  selectResult: (
    trigger: WorkflowTrigger,
    context: McpRequestContext,
  ) => Promise<McpOperationOutcome>;
};
export type InterchangeExposure =
  | InterchangeToolExposure
  | InterchangeAgentExposure
  | InterchangeHttpExposure
  | InterchangeWorkflowExposure;
export type InterchangeServerOptions = {
  auth: McpAuthPolicy;
  exposures: readonly InterchangeExposure[];
};
