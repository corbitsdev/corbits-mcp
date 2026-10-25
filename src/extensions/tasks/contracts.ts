import type {
  DetailedTask,
  InputRequests,
  InputResponses,
} from "../../protocol/index.js";

export interface McpTaskIdentity {
  tenantId: string;
  principalId: string;
  authorizationContextId: string;
}
export interface McpTaskRecord {
  identity: McpTaskIdentity;
  task: DetailedTask;
  revision: number;
  original: { method: "tools/call"; params: Record<string, unknown> };
  backend: Record<string, string>;
  /** Immutable history prevents key reuse even after requests are answered. */
  issued: InputRequests;
  answered: InputResponses;
  cancelRequested: boolean;
  dispatch: "pending" | "started";
}
/** All operations are atomic, linearizable and durable before resolving. */
export interface McpTaskStore {
  readonly durable: true;
  create(record: McpTaskRecord): Promise<void>;
  get(taskId: string): Promise<McpTaskRecord | undefined>;
  compareAndSwap(
    taskId: string,
    revision: number,
    next: McpTaskRecord,
  ): Promise<boolean>;
  list(): Promise<McpTaskRecord[]>;
  expire(now: number): Promise<void>;
}
export interface McpTaskExecutor {
  /** Start uses taskId as idempotency/correlation key; never hide ambiguous dispatch. */
  start(record: McpTaskRecord): Promise<void>;
  /** Reconcile backend state, including pending dispatch/input/cancel; do not blindly replay. */
  recover(record: McpTaskRecord): Promise<DetailedTask | undefined>;
  /** Responses already persisted. Host must authorize each approval/input binding. */
  submitInput(record: McpTaskRecord, responses: InputResponses): Promise<void>;
  requestCancel(record: McpTaskRecord): Promise<void>;
}
