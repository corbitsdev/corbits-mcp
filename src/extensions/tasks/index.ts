import { validateElicitationResponse } from "../elicitation.js";
import {
  validateTask as validateWireTask,
  validateInputResponses,
} from "../../protocol/index.js";
import type {
  DetailedTask,
  InputRequests,
  InputResponses,
} from "../../protocol/index.js";
import type {
  McpTaskExecutor,
  McpTaskIdentity,
  McpTaskRecord,
  McpTaskStore,
} from "./contracts.js";
export type * from "./contracts.js";
const terminal = (task: DetailedTask) =>
  ["completed", "failed", "cancelled"].includes(task.status);
const sameIdentity = (a: McpTaskIdentity, b: McpTaskIdentity) =>
  a.tenantId === b.tenantId &&
  a.principalId === b.principalId &&
  a.authorizationContextId === b.authorizationContextId;
const fail = (message: string): never => {
  throw Object.assign(new Error(message), { code: -32602 });
};
const waitingTask = (
  task: DetailedTask,
): Extract<DetailedTask, { status: "input_required" }> => {
  if (task.status === "input_required") return task;
  return fail("Task is not waiting for input");
};

export function createTaskRuntime(options: {
  store: McpTaskStore;
  executor: McpTaskExecutor;
  /** Shared protocol validator supplied by adapter, not a second wire validator. */
  validateTask?(task: DetailedTask): void;
  authorizeInput(
    identity: McpTaskIdentity,
    record: McpTaskRecord,
    responses: InputResponses,
  ): Promise<void>;
  now?: () => number;
}) {
  const { store, executor } = options;
  if (store.durable !== true) fail("A durable task store is required");
  const now = options.now ?? Date.now;
  const validateTask =
    options.validateTask ??
    ((task: DetailedTask) => {
      validateWireTask(task, true);
    });
  async function load(
    identity: McpTaskIdentity,
    taskId: string,
  ): Promise<McpTaskRecord> {
    const record = await store.get(taskId);
    if (
      !record ||
      !sameIdentity(identity, record.identity) ||
      (record.task.ttlMs !== null &&
        Date.parse(record.task.createdAt) + record.task.ttlMs <= now())
    )
      return fail("Unknown task");
    return record;
  }
  async function update(
    identity: McpTaskIdentity,
    taskId: string,
    change: (record: McpTaskRecord) => McpTaskRecord,
  ): Promise<McpTaskRecord> {
    for (let attempt = 0; attempt < 16; attempt++) {
      const record = await load(identity, taskId);
      const next = change(structuredClone(record));
      next.revision = record.revision + 1;
      validateTask(next.task);
      if (await store.compareAndSwap(taskId, record.revision, next))
        return next;
    }
    throw new Error("Task concurrent update limit exceeded");
  }
  async function transition(
    identity: McpTaskIdentity,
    taskId: string,
    task: DetailedTask,
    backend?: Record<string, string>,
  ) {
    return update(identity, taskId, (record) => {
      if (terminal(record.task)) return fail("Terminal tasks are immutable");
      if (task.taskId !== taskId || task.createdAt !== record.task.createdAt)
        return fail("Task identity cannot change");
      if (task.status === "input_required")
        for (const [key, request] of Object.entries(task.inputRequests)) {
          if (
            Object.hasOwn(record.answered, key) ||
            (Object.hasOwn(record.issued, key) &&
              JSON.stringify(record.issued[key]) !== JSON.stringify(request))
          )
            fail("Task input key reused");
          record.issued = { ...record.issued, [key]: structuredClone(request) };
        }
      record.task = structuredClone(task);
      record.task.lastUpdatedAt = new Date(now()).toISOString();
      if (backend) record.backend = structuredClone(backend);
      return record;
    });
  }
  return {
    async create(
      identity: McpTaskIdentity,
      params: Record<string, unknown>,
      ttlMs: number | null = 86_400_000,
    ) {
      if (Object.values(identity).some((v) => !v))
        fail("Task identity required");
      if (ttlMs !== null && (!Number.isSafeInteger(ttlMs) || ttlMs <= 0))
        fail("Invalid task TTL");
      const timestamp = new Date(now()).toISOString();
      const task: DetailedTask = {
        taskId: crypto.randomUUID(),
        status: "working",
        createdAt: timestamp,
        lastUpdatedAt: timestamp,
        ttlMs,
        pollIntervalMs: 1000,
      };
      validateTask(task);
      const record: McpTaskRecord = {
        identity: structuredClone(identity),
        task,
        revision: 0,
        original: { method: "tools/call", params: structuredClone(params) },
        backend: {},
        issued: {},
        answered: {},
        cancelRequested: false,
        dispatch: "pending",
      };
      await store.create(record);
      // A crash or ambiguous start remains a durable pending intent for recover().
      await executor.start(structuredClone(record));
      await update(identity, task.taskId, (next) => ({
        ...next,
        dispatch: "started",
      }));
      return { resultType: "task" as const, ...structuredClone(task) };
    },
    async get(identity: McpTaskIdentity, taskId: string) {
      return {
        ...(await load(identity, taskId)).task,
        resultType: "complete" as const,
      };
    },
    transition,
    async submitInput(
      identity: McpTaskIdentity,
      taskId: string,
      responses: InputResponses,
    ) {
      validateInputResponses(responses);
      const original = await load(identity, taskId);
      await options.authorizeInput(identity, original, responses);
      let accepted: InputResponses = {};
      const next = await update(identity, taskId, (record) => {
        accepted = {};
        const task = waitingTask(record.task);
        for (const [key, response] of Object.entries(responses))
          if (
            Object.hasOwn(task.inputRequests, key) &&
            !Object.hasOwn(record.answered, key)
          ) {
            const request = task.inputRequests[key];
            if (request?.method === "elicitation/create")
              validateElicitationResponse(request.params, response);
            accepted = { ...accepted, [key]: structuredClone(response) };
            record.answered = {
              ...record.answered,
              [key]: structuredClone(response),
            };
            delete task.inputRequests[key];
          }
        if (!Object.keys(accepted).length)
          fail("Task is not waiting for input");
        if (!Object.keys(task.inputRequests).length) {
          const { inputRequests: _requests, status: _status, ...base } = task;
          record.task = { ...base, status: "working" };
        }
        return record;
      });
      if (Object.keys(accepted).length)
        await executor.submitInput(next, accepted);
      return { resultType: "complete" as const };
    },
    async cancel(identity: McpTaskIdentity, taskId: string) {
      const record = await update(identity, taskId, (next) => {
        next.cancelRequested = true;
        return next;
      });
      if (!terminal(record.task)) await executor.requestCancel(record);
      return { resultType: "complete" as const };
    },
    async recover() {
      await store.expire(now());
      for (const record of await store.list())
        if (!terminal(record.task)) {
          let recovered: DetailedTask | undefined;
          try {
            recovered = await executor.recover(record);
          } catch {
            /* Persist truthful JSON-RPC recovery failure below. */
          }
          if (!recovered)
            recovered = {
              taskId: record.task.taskId,
              createdAt: record.task.createdAt,
              lastUpdatedAt: new Date(now()).toISOString(),
              ttlMs: record.task.ttlMs,
              status: "failed",
              error: {
                code: -32603,
                message:
                  "Task backend recovery unavailable; execution was not replayed",
              },
            };
          await transition(record.identity, record.task.taskId, recovered);
        }
    },
  };
}

export async function pollTask(options: {
  taskId: string;
  get(taskId: string): Promise<DetailedTask>;
  update(taskId: string, responses: InputResponses): Promise<void>;
  persist(taskId: string): Promise<void>;
  input?(requests: InputRequests): Promise<InputResponses>;
  observe?(task: DetailedTask): void;
  signal?: AbortSignal;
  maxPolls?: number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}): Promise<DetailedTask> {
  await options.persist(options.taskId);
  const answered = new Set<string>();
  const sleep =
    options.sleep ??
    ((ms, signal) =>
      new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(signal?.reason ?? new Error("Polling aborted"));
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", abort);
          resolve();
        }, ms);
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      }));
  for (let poll = 0; poll < (options.maxPolls ?? 10_000); poll++) {
    options.signal?.throwIfAborted();
    const task = await options.get(options.taskId);
    if (task.taskId !== options.taskId) fail("Task polling identity mismatch");
    options.observe?.(task);
    if (terminal(task)) return task;
    if (task.status === "input_required") {
      if (!options.input) throw new Error("Task elicitation host unavailable");
      const pending = Object.fromEntries(
        Object.entries(task.inputRequests).filter(
          ([key]) => !answered.has(key),
        ),
      );
      if (Object.keys(pending).length) {
        const responses = await options.input(pending);
        if (Object.keys(responses).some((key) => !Object.hasOwn(pending, key)))
          fail("Unexpected task input response");
        await options.update(options.taskId, responses);
        for (const key of Object.keys(responses)) answered.add(key);
      }
    }
    await sleep(Math.max(1, task.pollIntervalMs ?? 1000), options.signal);
  }
  throw new Error(
    "Task polling limit exceeded; durable task remains available",
  );
}
export { validateTaskRecord } from "./record.js";
