import { describe, expect, test } from "bun:test";
import {
  createSkillLoader,
  createSkillPublisher,
  parseSkillFrontmatter,
  SKILL_LIMITS,
} from "./index.js";
import type {
  McpSkillHostPolicy,
  McpSkillOrigin,
  SkillSource,
} from "./contracts.js";
const uri = "skill://demo/SKILL.md";
const encode = (text: string) => new TextEncoder().encode(text);
const main = encode(
  "---\nname: demo\ndescription: Demo skill\nmetadata:\n  author: example\nfuture-field: yes\n---\nUntrusted instructions\n",
);
const origin: McpSkillOrigin = {
  serverId: "host-assigned-A",
  tenantId: "t",
  principalId: "p",
  authorizationContextId: "auth",
};
async function fixture(extra = new Map<string, Uint8Array>()) {
  const files = new Map([[uri, main], ...extra]);
  const publisher = await createSkillPublisher([{ uri, files }]);
  let reads = 0;
  const source: SkillSource = {
    async get(_origin, key) {
      return publisher.get(key).skill;
    },
    async read(_origin, key) {
      reads++;
      return files.get(key)!.slice();
    },
  };
  return { files, publisher, source, reads: () => reads };
}
function policy(events: string[], execution = false): McpSkillHostPolicy {
  return {
    async approve(held) {
      events.push("approve");
      return {
        identity: held.identity,
        fingerprint: held.fingerprint,
        approved: true,
        execution,
      };
    },
    async openActingWindow() {
      events.push("gate");
      return {
        async admit(content) {
          expect(content.trust).toBe("untrusted-mcp");
          events.push("admit");
        },
        async removeContext() {
          events.push("remove");
        },
        async close() {
          events.push("close");
        },
      };
    },
  };
}
describe("pinned Skills integrity and approval", () => {
  test("publishes complete manifests, verbatim frontmatter and direct directory children", async () => {
    const f = await fixture(
      new Map([["skill://demo/scripts/run.sh", encode("echo safe")]]),
    );
    expect(f.publisher.list().skills).toHaveLength(1);
    const entry = f.publisher.get(uri).skill;
    expect(entry.frontmatter["future-field"]).toBe("yes");
    expect(entry.resources).toHaveLength(2);
    expect(f.publisher.directoryRead("skill://demo").resources).toContainEqual({
      uri: "skill://demo/scripts",
      name: "scripts",
      mimeType: "inode/directory",
    });
    expect(() => f.publisher.get("skill://missing/SKILL.md")).toThrow(
      "Unknown",
    );
    expect(f.publisher.read(uri).contents[0]?.blob).toBe(
      Buffer.from(main).toString("base64"),
    );
  });
  test("directoryRead returns a file and a same-prefix directory", async () => {
    const f = await fixture(
      new Map([
        ["skill://demo/scripts", encode("not a directory")],
        ["skill://demo/scripts/run.sh", encode("echo safe")],
      ]),
    );
    const scripts = f.publisher
      .directoryRead("skill://demo")
      .resources.filter((resource) => resource.name === "scripts");
    expect(scripts).toHaveLength(2);
    expect(scripts).toContainEqual({
      uri: "skill://demo/scripts",
      name: "scripts",
    });
    expect(scripts).toContainEqual({
      uri: "skill://demo/scripts",
      name: "scripts",
      mimeType: "inode/directory",
    });
  });
  test("lazy retrieval, isolated cache, immutable entry and bytes", async () => {
    const f = await fixture();
    const loader = createSkillLoader(f.source);
    const held = await loader.get(origin, uri);
    expect(f.reads()).toBe(0);
    const first = await loader.verify(held);
    first.bytes.fill(0);
    expect((await loader.verify(held)).bytes).toEqual(main);
    expect(f.reads()).toBe(1);
    const other = await loader.get({ ...origin, serverId: "B" }, uri);
    expect(other.identity).not.toBe(held.identity);
    await loader.verify(other);
    expect(f.reads()).toBe(2);
    expect(Object.isFrozen(held.entry.frontmatter)).toBe(true);
    await expect(loader.activate(held)).rejects.toThrow(
      "host policy unavailable",
    );
  });
  test("approval precedes admission, no implicit execution and ordered teardown", async () => {
    const f = await fixture();
    const events: string[] = [];
    const loader = createSkillLoader(f.source, policy(events));
    const lease = await loader.activate(await loader.get(origin, uri));
    expect(events).toEqual(["approve", "gate", "admit"]);
    expect(() => lease.assertExecutionApproved()).toThrow("execution approval");
    await lease.release();
    expect(events.slice(-2)).toEqual(["remove", "close"]);
    await expect(lease.read(uri)).rejects.toThrow("closed");
  });
  test("manifest changes revoke live execution and require reapproval", async () => {
    const f = await fixture();
    const events: string[] = [];
    const loader = createSkillLoader(f.source, policy(events, true));
    const lease = await loader.activate(await loader.get(origin, uri));
    lease.assertExecutionApproved();
    const newFiles = new Map([
      [uri, main],
      ["skill://demo/new.txt", encode("new")],
    ]);
    const changed = await createSkillPublisher([{ uri, files: newFiles }]);
    const fresh = await loader.hold(origin, changed.get(uri).skill);
    expect(() => lease.assertExecutionApproved()).toThrow("revoked");
    await loader.activate(fresh);
    expect(events.filter((v) => v === "approve")).toHaveLength(2);
  });
  test("size, digest, frontmatter and unlisted bytes fail closed", async () => {
    for (const corruption of [encode("short"), new Uint8Array(main.length)]) {
      const f = await fixture();
      f.files.set(uri, corruption);
      const loader = createSkillLoader(f.source);
      await expect(
        loader.verify(await loader.get(origin, uri)),
      ).rejects.toThrow("integrity");
    }
    const f = await fixture();
    const entry = f.publisher.get(uri).skill;
    entry.frontmatter.description = "Lie";
    const loader = createSkillLoader(f.source);
    const held = await loader.hold(origin, entry);
    await expect(loader.verify(held)).rejects.toThrow("frontmatter mismatch");
    const reheld = await loader.hold(origin, f.publisher.get(uri).skill);
    await expect(
      loader.verify(reheld, "skill://demo/unlisted"),
    ).rejects.toThrow("Unlisted");
    await expect(
      loader.hold(origin, { ...entry, resources: "dynamic" }),
    ).rejects.toThrow("Dynamic");
  });
  test("rejects traversal, missing SKILL.md, duplicate manifests and mismatched receipts", async () => {
    const f = await fixture();
    const entry = f.publisher.get(uri).skill;
    if (entry.resources === "dynamic") throw new Error("fixture");
    const loader = createSkillLoader(f.source);
    await expect(
      loader.hold(origin, {
        ...entry,
        resources: [...entry.resources, ...entry.resources],
      }),
    ).rejects.toThrow("duplicate");
    await expect(
      loader.hold(origin, { ...entry, resources: [] }),
    ).rejects.toThrow("omits");
    await expect(
      loader.hold(origin, {
        ...entry,
        resources: [
          ...entry.resources,
          { ...entry.resources[0]!, uri: "skill://demo/%2e%2e/escape" },
        ],
      }),
    ).rejects.toThrow("Unsafe");
    const bad = policy([]);
    bad.approve = async (held) => ({
      identity: "other",
      fingerprint: held.fingerprint,
      approved: true,
      execution: true,
    });
    const guarded = createSkillLoader(f.source, bad);
    await expect(
      guarded.activate(await guarded.get(origin, uri)),
    ).rejects.toThrow("mismatched");
  });
  test("supports exact normative limits and rejects excess before reads", async () => {
    const files = new Map([[uri, main]]);
    for (let i = 0; i < 511; i++)
      files.set(
        `skill://demo/${i}.bin`,
        new Uint8Array(i === 0 ? SKILL_LIMITS.bytes - main.length : 0),
      );
    const publisher = await createSkillPublisher([{ uri, files }]);
    const loader = createSkillLoader({
      async get() {
        return publisher.get(uri).skill;
      },
      async read(_origin, key) {
        return files.get(key)!;
      },
    });
    const held = await loader.get(origin, uri);
    expect((await loader.verify(held, "skill://demo/0.bin")).bytes.length).toBe(
      SKILL_LIMITS.bytes - main.length,
    );
    const entry = publisher.get(uri).skill;
    if (entry.resources === "dynamic") throw new Error("fixture");
    entry.resources.push({
      uri: "skill://demo/excess",
      digest: `sha256:${"0".repeat(64)}`,
      size: 0,
    });
    await expect(loader.hold(origin, entry)).rejects.toThrow("512");
  });
  test("bounded YAML rejects aliases, malformed frontmatter and name mismatch", () => {
    for (const yaml of [
      "name: demo\ndescription: &a test\nx: *a",
      "name: wrong\ndescription: test",
      "name: demo\nname: demo\ndescription: test",
    ])
      expect(() =>
        parseSkillFrontmatter(encode(`---\n${yaml}\n---\n`), uri),
      ).toThrow();
  });
});
test("unlisted reads revoke live execution approval", async () => {
  const f = await fixture();
  const loader = createSkillLoader(f.source, policy([], true));
  const held = await loader.get(origin, uri);
  const lease = await loader.activate(held);
  await expect(lease.read("skill://demo/not-in-held-manifest")).rejects.toThrow(
    "Unlisted",
  );
  expect(() => lease.assertExecutionApproved()).toThrow();
});
test("nested supporting SKILL.md does not activate or inherit approval", async () => {
  const nestedUri = "skill://demo/nested/SKILL.md";
  const nested = encode(
    "---\nname: nested\ndescription: Nested instructions\nallowed-tools: Shell\n---\n",
  );
  const f = await fixture(new Map([[nestedUri, nested]]));
  const publisher = await createSkillPublisher([
    { uri, files: f.files },
    { uri: nestedUri, files: new Map([[nestedUri, nested]]) },
  ]);
  const events: string[] = [];
  const loader = createSkillLoader(
    {
      ...f.source,
      async get(_origin, key) {
        return publisher.get(key).skill;
      },
    },
    policy(events, true),
  );
  const outer = await loader.activate(await loader.get(origin, uri));
  await outer.read(nestedUri);
  expect(events.filter((v) => v === "approve")).toHaveLength(1);
  await loader.activate(await loader.get(origin, nestedUri));
  expect(events.filter((v) => v === "approve")).toHaveLength(2);
});
