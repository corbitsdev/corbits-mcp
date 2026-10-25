import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileTaskStore } from "./file-store.js";
import { createTaskRuntime, pollTask, validateTaskRecord } from "./index.js";
import type {
  McpTaskExecutor,
  McpTaskIdentity,
  McpTaskStore,
} from "./contracts.js";
import type { DetailedTask, InputRequests } from "../../protocol/index.js";
const identity: McpTaskIdentity = {
  tenantId: "t",
  principalId: "p",
  authorizationContextId: "auth",
};
const requests: InputRequests = {
  approval: {
    method: "elicitation/create",
    params: {
      message: "Approve?",
      requestedSchema: {
        type: "object",
        properties: { yes: { type: "boolean" } },
        required: ["yes"],
      },
    },
  },
};
const executor: McpTaskExecutor = {
  async start() {},
  async recover() {
    return undefined;
  },
  async submitInput() {},
  async requestCancel() {},
};
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "mcp-tasks-"));
  const store = await createFileTaskStore({
    directory,
    validateRecord: validateTaskRecord,
  });
  return {
    directory,
    store,
    async cleanup() {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
test("durable creation, restart, exclusive writer, CAS and identity isolation", async () => {
  const f = await fixture();
  let store = f.store;
  try {
    await expect(
      createFileTaskStore({
        directory: f.directory,
        validateRecord: validateTaskRecord,
      }),
    ).rejects.toThrow();
    const runtime = createTaskRuntime({
      store,
      executor,
      async authorizeInput() {},
    });
    const task = await runtime.create(identity, { name: "work" });
    expect(task.resultType).toBe("task");
    expect((await store.get(task.taskId))?.dispatch).toBe("started");
    await expect(
      runtime.get({ ...identity, tenantId: "other" }, task.taskId),
    ).rejects.toThrow("Unknown");
    const record = (await store.get(task.taskId))!;
    expect(
      await store.compareAndSwap(task.taskId, record.revision - 1, record),
    ).toBe(false);
    await store.close();
    store = await createFileTaskStore({
      directory: f.directory,
      validateRecord: validateTaskRecord,
    });
    expect((await store.get(task.taskId))?.original.params.name).toBe("work");
    const restarted = createTaskRuntime({
      store,
      executor,
      async authorizeInput() {},
    });
    await restarted.recover();
    expect((await restarted.get(identity, task.taskId)).status).toBe("failed");
  } finally {
    await store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
test("input authorization, partial answers, lifetime key uniqueness, cooperative cancel and terminal immutability", async () => {
  const f = await fixture();
  let submissions = 0;
  let cancellations = 0;
  let allow = false;
  try {
    const runtime = createTaskRuntime({
      store: f.store,
      executor: {
        ...executor,
        async submitInput() {
          submissions++;
        },
        async requestCancel() {
          cancellations++;
        },
      },
      async authorizeInput() {
        if (!allow) throw new Error("Unauthorized approver");
      },
    });
    const initial = await runtime.create(identity, { name: "work" });
    await runtime.transition(identity, initial.taskId, {
      ...initial,
      status: "input_required",
      inputRequests: { ...requests, second: requests.approval! },
    });
    await expect(
      runtime.submitInput(identity, initial.taskId, {
        approval: { action: "accept", content: { yes: true } },
      }),
    ).rejects.toThrow("Unauthorized");
    allow = true;
    await expect(
      runtime.submitInput(identity, initial.taskId, {
        approval: { action: "accept", content: { yes: "invalid" } },
      }),
    ).rejects.toThrow();
    await runtime.submitInput(identity, initial.taskId, {
      approval: { action: "accept", content: { yes: true } },
      unknown: { action: "cancel" },
    });
    expect(submissions).toBe(1);
    expect((await runtime.get(identity, initial.taskId)).status).toBe(
      "input_required",
    );
    const answeredRevision = (await f.store.get(initial.taskId))!.revision;
    await expect(
      runtime.submitInput(identity, initial.taskId, {
        approval: { action: "accept", content: { yes: true } },
      }),
    ).rejects.toThrow("not waiting");
    expect(submissions).toBe(1);
    expect((await f.store.get(initial.taskId))!.revision).toBe(
      answeredRevision,
    );
    await expect(
      runtime.transition(identity, initial.taskId, {
        ...initial,
        status: "input_required",
        inputRequests: requests,
      }),
    ).rejects.toThrow("reused");
    await runtime.cancel(identity, initial.taskId);
    expect(cancellations).toBe(1);
    expect((await runtime.get(identity, initial.taskId)).status).toBe(
      "input_required",
    );
    expect((await f.store.get(initial.taskId))?.cancelRequested).toBe(true);
    await runtime.transition(identity, initial.taskId, {
      ...initial,
      status: "completed",
      result: { content: [{ type: "text", text: "done" }] },
    });
    await expect(
      runtime.transition(identity, initial.taskId, {
        ...initial,
        status: "working",
      }),
    ).rejects.toThrow("immutable");
  } finally {
    await f.cleanup();
  }
});
test("expired tasks are inaccessible and removed; ambiguous dispatch is durable before recovery", async () => {
  const f = await fixture();
  let now = Date.now();
  try {
    const runtime = createTaskRuntime({
      store: f.store,
      executor: {
        ...executor,
        async start(record) {
          expect(await f.store.get(record.task.taskId)).toBeDefined();
          throw new Error("ambiguous dispatch");
        },
      },
      now: () => now,
      async authorizeInput() {},
    });
    await expect(
      runtime.create(identity, { name: "work" }, 10),
    ).rejects.toThrow("ambiguous");
    const records = await f.store.list();
    expect(records[0]?.dispatch).toBe("pending");
    now += 11;
    await expect(
      runtime.get(identity, records[0]!.task.taskId),
    ).rejects.toThrow("Unknown");
    await runtime.recover();
    expect(await f.store.list()).toHaveLength(0);
  } finally {
    await f.cleanup();
  }
});
test("submitInput fails without a revision bump unless the task is waiting for that input", async () => {
  const f = await fixture();
  let submissions = 0;
  const countInput: McpTaskExecutor = {
    ...executor,
    async submitInput() {
      submissions++;
    },
  };
  try {
    const runtime = createTaskRuntime({
      store: f.store,
      executor: countInput,
      async authorizeInput() {},
    });
    const created = await runtime.create(identity, { name: "work" });
    const before = (await f.store.get(created.taskId))!;
    await expect(
      runtime.submitInput(identity, created.taskId, {
        approval: { action: "accept", content: { yes: true } },
      }),
    ).rejects.toThrow("not waiting");
    const after = (await f.store.get(created.taskId))!;
    expect(after.revision).toBe(before.revision);
    expect(after.answered).toEqual({});
    expect(after.task.status).toBe("working");
    expect(submissions).toBe(0);
    await runtime.transition(identity, created.taskId, {
      ...created,
      status: "input_required",
      inputRequests: requests,
    });
    const waiting = (await f.store.get(created.taskId))!;
    let raced = false;
    const store: McpTaskStore = {
      durable: true,
      create: (record) => f.store.create(record),
      get: (taskId) => f.store.get(taskId),
      list: () => f.store.list(),
      expire: (now) => f.store.expire(now),
      async compareAndSwap(taskId, revision, next) {
        if (!raced) {
          raced = true;
          const current = await f.store.get(taskId);
          if (!current) return false;
          const { inputRequests: _pending, ...task } = current.task;
          await f.store.compareAndSwap(taskId, current.revision, {
            ...current,
            revision: current.revision + 1,
            task: { ...task, status: "working" },
          });
          return false;
        }
        return f.store.compareAndSwap(taskId, revision, next);
      },
    };
    const racing = createTaskRuntime({
      store,
      executor: countInput,
      async authorizeInput() {},
    });
    await expect(
      racing.submitInput(identity, created.taskId, {
        approval: { action: "accept", content: { yes: true } },
      }),
    ).rejects.toThrow("not waiting");
    const racedRecord = (await f.store.get(created.taskId))!;
    expect(raced).toBe(true);
    expect(racedRecord.revision).toBe(waiting.revision + 1);
    expect(racedRecord.answered).toEqual({});
    expect(racedRecord.task.status).toBe("working");
    expect(submissions).toBe(0);
  } finally {
    await f.cleanup();
  }
});
test("polling persists identity, honors interval, deduplicates input and returns final result", async () => {
  const initial: DetailedTask = {
    taskId: "id",
    status: "input_required",
    createdAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    ttlMs: null,
    pollIntervalMs: 12,
    inputRequests: requests,
  };
  let polls = 0;
  let inputs = 0;
  let persisted = false;
  const waits: number[] = [];
  const result = await pollTask({
    taskId: "id",
    async persist() {
      persisted = true;
    },
    async get() {
      expect(persisted).toBe(true);
      return ++polls < 3
        ? initial
        : { ...initial, status: "completed", result: { content: [] } };
    },
    async input() {
      inputs++;
      return { approval: { action: "decline" } };
    },
    async update() {},
    async sleep(ms) {
      waits.push(ms);
    },
  });
  expect(result.status).toBe("completed");
  expect(inputs).toBe(1);
  expect(waits).toEqual([12, 12]);
  await expect(
    pollTask({
      taskId: "id",
      async persist() {},
      async get() {
        return initial;
      },
      async update() {},
    }),
  ).rejects.toThrow("host unavailable");
});
