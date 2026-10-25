import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkillLoader, createSkillPublisher } from "./skills/index.js";
import { createFileTaskStore } from "./tasks/file-store.js";
import { createTaskRuntime, validateTaskRecord } from "./tasks/index.js";
import { createElicitationRuntime } from "./elicitation.js";
import type { McpSkillHostPolicy } from "./skills/contracts.js";
import type { ElicitRequestParams, ElicitResult } from "../protocol/index.js";

const uri = "skill://demo/SKILL.md";
const support = "skill://demo/code.txt";
const origin = {
  serverId: "server",
  tenantId: "tenant",
  principalId: "principal",
  authorizationContextId: "auth",
};
const bytes = new TextEncoder().encode(
  "---\nname: demo\ndescription: Demo\n---\nInstructions",
);
async function publication() {
  return createSkillPublisher([
    {
      uri,
      files: new Map([
        [uri, bytes],
        [support, new Uint8Array([1])],
      ]),
    },
  ]);
}
const host: McpSkillHostPolicy = {
  async approve(held) {
    return {
      identity: held.identity,
      fingerprint: held.fingerprint,
      approved: true,
      execution: true,
    };
  },
  async openActingWindow() {
    return { async admit() {}, async removeContext() {}, async close() {} };
  },
};
for (const method of ["list", "get", "read", "directoryRead"] as const) {
  test(`publisher ${method} carries conservative wire cache policy`, async () => {
    const publisher = await publication();
    const result =
      method === "list"
        ? publisher.list()
        : publisher[method](method === "directoryRead" ? "skill://demo" : uri);
    const wire = JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    expect(wire.result.resultType).toBe("complete");
    expect(wire.result.ttlMs).toBe(0);
    expect(wire.result.cacheScope).toBe("private");
  });
}
test("source rejection revokes live execution and requires a fresh held entry", async () => {
  const publisher = await publication();
  const loader = createSkillLoader(
    {
      async get() {
        return publisher.get(uri).skill;
      },
      async read(_origin, key) {
        if (key === support) throw new Error("source size limit");
        return bytes;
      },
    },
    host,
  );
  const held = await loader.get(origin, uri);
  const lease = await loader.activate(held);
  await expect(lease.read(support)).rejects.toThrow("source size limit");
  expect(() => lease.assertExecutionApproved()).toThrow("revoked");
  await expect(loader.activate(held)).rejects.toThrow("revoked");
  const fresh = await loader.activate(await loader.get(origin, uri));
  fresh.assertExecutionApproved();
  expect(() => lease.assertExecutionApproved()).toThrow("revoked");
});
for (const change of ["clear", "rotate"] as const) {
  test(`revoked lease never revives after ${change} and identical reactivation`, async () => {
    const publisher = await publication();
    const loader = createSkillLoader(
      {
        async get() {
          return publisher.get(uri).skill;
        },
        async read() {
          return bytes;
        },
      },
      host,
    );
    const lease = await loader.activate(await loader.get(origin, uri));
    if (change === "clear") loader.clear();
    else {
      const changed = publisher.get(uri).skill;
      changed.frontmatter.description = "changed";
      await loader.hold(origin, changed);
    }
    expect(() => lease.assertExecutionApproved()).toThrow("revoked");
    const fresh = await loader.activate(await loader.get(origin, uri));
    fresh.assertExecutionApproved();
    expect(() => lease.assertExecutionApproved()).toThrow("revoked");
    await expect(lease.read(uri)).rejects.toThrow("revoked");
  });
}
test("repeated and concurrent stale closes cannot unlink a successor writer lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-close-regression-"));
  const options = { directory, validateRecord: validateTaskRecord };
  const a = await createFileTaskStore(options);
  let b: Awaited<ReturnType<typeof createFileTaskStore>> | undefined;
  let c: Awaited<ReturnType<typeof createFileTaskStore>> | undefined;
  try {
    const pendingRead = a.list();
    const closing = a.close();
    await expect(a.list()).rejects.toThrow("closed");
    await Promise.all([closing, a.close()]);
    await pendingRead;
    b = await createFileTaskStore(options);
    await Promise.all([a.close(), a.close()]);
    await expect(
      createFileTaskStore(options).then((store) => {
        c = store;
      }),
    ).rejects.toThrow();
    await Promise.all([b.close(), b.close()]);
    c = await createFileTaskStore(options);
    await Promise.all([a.close(), b.close()]);
    await expect(createFileTaskStore(options)).rejects.toThrow();
  } finally {
    await a.close();
    await b?.close();
    await c?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
const cases: {
  name: string;
  params: ElicitRequestParams;
  response: ElicitResult;
}[] = [
  {
    name: "URL content",
    params: { mode: "url", url: "https://example.com", message: "Continue" },
    response: { action: "accept", content: { token: "secret" } },
  },
  {
    name: "declined form content",
    params: {
      message: "Continue",
      requestedSchema: { type: "object", properties: {} },
    },
    response: { action: "decline", content: { token: "secret" } },
  },
];
for (const entry of cases)
  test(`direct and task elicitation reject ${entry.name} before durable mutation`, async () => {
    const request = {
      method: "elicitation/create" as const,
      params: entry.params,
    };
    await expect(
      createElicitationRuntime({
        async form() {
          return entry.response;
        },
        async url() {
          return entry.response;
        },
      }).respond({ input: request }),
    ).rejects.toThrow();
    const directory = await mkdtemp(join(tmpdir(), "mcp-input-regression-"));
    const store = await createFileTaskStore({
      directory,
      validateRecord: validateTaskRecord,
    });
    let dispatched = 0;
    try {
      const runtime = createTaskRuntime({
        store,
        async authorizeInput() {},
        executor: {
          async start() {},
          async recover() {
            return undefined;
          },
          async requestCancel() {},
          async submitInput() {
            dispatched++;
          },
        },
      });
      const task = await runtime.create(origin, { name: "test" });
      await runtime.transition(origin, task.taskId, {
        ...task,
        status: "input_required",
        inputRequests: { input: request },
      });
      const before = await store.get(task.taskId);
      await expect(
        runtime.submitInput(origin, task.taskId, { input: entry.response }),
      ).rejects.toThrow();
      expect(await store.get(task.taskId)).toEqual(before);
      expect(dispatched).toBe(0);
      await runtime.submitInput(origin, task.taskId, {
        input: { action: "decline" },
      });
      expect(dispatched).toBe(1);
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
