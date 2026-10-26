import assert from "node:assert/strict";
import * as root from "@corbits/mcp";
import * as client from "@corbits/mcp/client";
import * as consume from "@corbits/mcp/interchange/client";
import * as expose from "@corbits/mcp/interchange/server";
import * as sidecar from "@corbits/mcp/sidecar-bundle";
import { createSkillPublisher } from "@corbits/mcp/server";

assert.equal(root.mcpConnect, client.mcpConnect);
assert.equal(root.mcpTools, consume.mcpTools);
assert.equal(typeof expose.createInterchangeProviders, "function");
assert.equal(typeof sidecar.mcpServers, "function");
const uri = "skill://demo/SKILL.md";
const bytes = new TextEncoder().encode(
  "---\nname: demo\ndescription: Packed example\n---\nUntrusted instructions.\n",
);
const publisher = await createSkillPublisher([
  { uri, files: new Map([[uri, bytes]]) },
]);
const loader = consume.createSkillLoader({
  async get(_origin, requested) {
    return publisher.get(requested).skill;
  },
  async read(_origin, requested) {
    return Buffer.from(publisher.read(requested).contents[0].blob, "base64");
  },
});
const held = await loader.get(
  {
    serverId: "server",
    tenantId: "tenant",
    principalId: "principal",
    authorizationContextId: "partition",
  },
  uri,
);
const verified = await loader.verify(held);
assert.deepEqual(Buffer.from(verified.bytes), Buffer.from(bytes));
assert.equal(verified.trust, "untrusted-mcp");
await assert.rejects(loader.activate(held), /host|policy|activation/i);
loader.clear();

console.log("packed host APIs passed");
