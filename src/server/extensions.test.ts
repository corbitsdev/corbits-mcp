import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMcpServer,
  createTaskProviders,
  createSkillProviders,
} from "../server.js";
import { createTaskRuntime } from "../extensions/tasks/index.js";
import { createFileTaskStore } from "../extensions/tasks/file-store.js";
import { createSkillPublisher } from "../extensions/skills/index.js";
import {
  validateTask,
  MCP_EXT_TASKS,
  MCP_EXT_SKILLS,
} from "../protocol/index.js";
import { rpc, result } from "./fixtures.js";
import type { McpTaskRecord } from "../extensions/tasks/contracts.js";
import type { McpAuthPolicy } from "../auth/contracts.js";

const identity = {
  tenantId: "tenant",
  principalId: "principal",
  authorizationContextId: "grants",
  scopes: [],
};
const auth: McpAuthPolicy = {
  authenticate: () => identity,
  authorize: () => true,
};
const serverInfo = { name: "extensions", version: "1" };
const meta = (extensions: Record<string, unknown>) => ({
  "io.modelcontextprotocol/clientCapabilities": { extensions },
});

test("task provider uses durable runtime and rejects cross-principal and non-opted-in reads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-server-tasks-"));
  const store = await createFileTaskStore({
    directory,
    validateRecord(value) {
      const record = value as McpTaskRecord;
      validateTask(record.task, true);
      return record;
    },
  });
  let cancels = 0;
  const runtime = createTaskRuntime({
    store,
    validateTask: (task) => {
      validateTask(task, true);
    },
    authorizeInput: async () => {},
    executor: {
      start: async () => {},
      recover: async (record) => record.task,
      submitInput: async () => {},
      requestCancel: async () => {
        cancels++;
      },
    },
  });
  const task = await runtime.create(identity, { name: "work" });
  const extensions = { [MCP_EXT_TASKS]: {} };
  const server = createMcpServer({
    serverInfo,
    auth,
    extensions,
    providers: createTaskProviders(runtime),
  });
  const other = createMcpServer({
    serverInfo,
    auth: {
      ...auth,
      authenticate: () => ({ ...identity, principalId: "other" }),
    },
    extensions,
    providers: createTaskProviders(runtime),
  });
  try {
    expect(
      await result(
        await server.fetch(
          rpc("tasks/get", { taskId: task.taskId, _meta: meta(extensions) }),
        ),
      ),
    ).toMatchObject({ result: { taskId: task.taskId, status: "working" } });
    expect(
      await result(
        await server.fetch(rpc("tasks/get", { taskId: task.taskId })),
      ),
    ).toHaveProperty("error");
    expect(
      await result(
        await other.fetch(
          rpc("tasks/get", { taskId: task.taskId, _meta: meta(extensions) }),
        ),
      ),
    ).toHaveProperty("error");
    expect(
      await result(
        await server.fetch(
          rpc("tasks/cancel", { taskId: task.taskId, _meta: meta(extensions) }),
        ),
      ),
    ).toMatchObject({ result: { resultType: "complete" } });
    expect(cancels).toBe(1);
    expect((await store.get(task.taskId))?.cancelRequested).toBe(true);
  } finally {
    await server.close();
    await other.close();
    await store.close();
    await rm(directory, { recursive: true });
  }
});

test("skill snapshot publishes through enabled provider seam without activation", async () => {
  const uri = "https://skills.example/greet/SKILL.md";
  const publisher = await createSkillPublisher([
    {
      uri,
      files: new Map([
        [
          uri,
          new TextEncoder().encode(
            "---\nname: greet\ndescription: Greet politely\n---\nSay hello.\n",
          ),
        ],
      ]),
    },
  ]);
  const extensions = { [MCP_EXT_SKILLS]: { directoryRead: true } };
  const server = createMcpServer({
    serverInfo,
    auth,
    extensions,
    providers: createSkillProviders(publisher, "skills:approved"),
  });
  try {
    expect(
      await result(
        await server.fetch(rpc("skills/list", { _meta: meta(extensions) })),
      ),
    ).toMatchObject({ result: { skills: [{ uri }] } });
    // Skills have no Mcp-Name source in the pinned wire contract.
    const request = rpc("skills/get", { uri, _meta: meta(extensions) });
    request.headers.delete("Mcp-Name");
    expect(await result(await server.fetch(request))).toMatchObject({
      result: { skill: { uri } },
    });
    expect(
      await result(
        await server.fetch(
          rpc("resources/read", { uri, _meta: meta(extensions) }),
        ),
      ),
    ).toHaveProperty("result.contents");
    expect(await result(await server.fetch(rpc("skills/list")))).toHaveProperty(
      "error",
    );
  } finally {
    await server.close();
  }
});

test("auth challenge factory response is preserved", async () => {
  const server = createMcpServer({
    serverInfo,
    auth: { ...auth, authenticate: () => null },
    challenge: (status) =>
      new Response(null, {
        status,
        headers: {
          "WWW-Authenticate":
            'Bearer resource_metadata="https://auth.example/.well-known/oauth-protected-resource"',
        },
      }),
  });
  const response = await server.fetch(rpc("server/discover"));
  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toContain(
    "resource_metadata",
  );
  await server.close();
});
