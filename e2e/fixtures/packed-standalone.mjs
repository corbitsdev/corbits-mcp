import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSkillPublisher,
  createTaskRuntime,
  validateTaskRecord,
  createMcpResourceServerAuth,
} from "@corbits/mcp/server";
import { createFileTaskStore } from "@corbits/mcp/server/task-store";

const uri = "skill://demo/SKILL.md";
const bytes = new TextEncoder().encode(
  "---\nname: demo\ndescription: Packed example\n---\nUntrusted instructions.\n",
);
const publisher = await createSkillPublisher([
  { uri, files: new Map([[uri, bytes]]) },
]);
assert.equal(publisher.list().skills[0].uri, uri);
assert.equal(publisher.get(uri).skill.resources[0].size, bytes.length);
assert.deepEqual(
  Buffer.from(publisher.read(uri).contents[0].blob, "base64"),
  Buffer.from(bytes),
);

const identity = {
  tenantId: "tenant",
  principalId: "principal",
  authorizationContextId: "partition",
};
const directory = await mkdtemp(join(tmpdir(), "packed-mcp-tasks-"));
let store;
let starts = 0;
let recovered = 0;
const executor = {
  async start() {
    starts++;
  },
  async recover(record) {
    recovered++;
    return {
      ...record.task,
      status: "completed",
      result: { content: [{ type: "text", text: "recovered" }] },
    };
  },
  async submitInput() {
    throw new Error("No input expected");
  },
  async requestCancel() {
    throw new Error("No cancellation expected");
  },
};
try {
  store = await createFileTaskStore({
    directory,
    validateRecord: validateTaskRecord,
  });
  const runtime = createTaskRuntime({
    store,
    executor,
    authorizeInput: async () => {
      throw new Error("No input expected");
    },
  });
  const task = await runtime.create(identity, { name: "echo", arguments: {} });
  assert.equal(task.resultType, "task");
  assert.equal(starts, 1);
  assert.equal((await runtime.get(identity, task.taskId)).status, "working");
  await store.close();
  store = await createFileTaskStore({
    directory,
    validateRecord: validateTaskRecord,
  });
  const restarted = createTaskRuntime({
    store,
    executor,
    authorizeInput: async () => {},
  });
  await restarted.recover();
  assert.equal(recovered, 1);
  assert.equal(starts, 1, "recovery must not replay start");
  const result = await restarted.get(identity, task.taskId);
  assert.equal(result.status, "completed");
  assert.equal(result.result.content[0].text, "recovered");
  await assert.rejects(
    restarted.get({ ...identity, principalId: "other" }, task.taskId),
  );
} finally {
  await store?.close();
  await rm(directory, { recursive: true, force: true });
}

// Injected verifier is a host contract, not a claim of cryptographic verification.
const auth = createMcpResourceServerAuth({
  resource: "https://mcp.example/mcp",
  resourceMetadataUrl:
    "https://mcp.example/.well-known/oauth-protected-resource/mcp",
  authorizationServers: ["https://auth.example"],
  async verifyAccessToken(token) {
    assert.equal(token, "fixture-token");
    return {
      issuer: "https://auth.example",
      audience: ["https://mcp.example/mcp"],
      expiresAt: Date.now() + 60_000,
      identity: { ...identity, scopes: ["read"] },
    };
  },
  authorize: () => true,
});
assert.equal(
  await auth.policy.authenticate(new Request("https://mcp.example/mcp")),
  null,
);
assert.equal(
  (
    await auth.policy.authenticate(
      new Request("https://mcp.example/mcp", {
        headers: { authorization: "Bearer fixture-token" },
      }),
    )
  ).principalId,
  "principal",
);
assert.equal(auth.challenge(401).status, 401);
assert.match(
  auth.challenge(401).headers.get("www-authenticate"),
  /resource_metadata=/,
);
assert.equal(
  (await auth.metadataResponse().json()).resource,
  "https://mcp.example/mcp",
);
console.log("packed standalone lifecycle passed");
