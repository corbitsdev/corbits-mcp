import { expect, spyOn, test } from "bun:test";
import { createSkillLoader, createSkillPublisher } from "./index.js";
import type {
  McpSkillHostPolicy,
  McpSkillOrigin,
  SkillSource,
} from "./contracts.js";

for (const stale of ["frontmatter mismatch", "success"] as const) {
  test(`stale verification ${stale} cannot revoke or serve after generation replacement`, async () => {
    const uri = "skill://demo/SKILL.md";
    const bytes = new TextEncoder().encode(
      "---\nname: demo\ndescription: Correct\n---\nInstructions",
    );
    const publisher = await createSkillPublisher([
      { uri, files: new Map([[uri, bytes]]) },
    ]);
    const origin = {
      serverId: "server",
      tenantId: "tenant",
      principalId: "principal",
      authorizationContextId: "auth",
    };
    let approvals = 0;
    const host: McpSkillHostPolicy = {
      async approve(held) {
        approvals++;
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
    const entry = publisher.get(uri).skill;
    if (stale === "frontmatter mismatch")
      entry.frontmatter.description = "Incorrect";
    const a = await loader.hold(origin, entry);
    let reached!: () => void;
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realDigest = crypto.subtle.digest.bind(crypto.subtle);
    let first = true;
    const spy = spyOn(crypto.subtle, "digest").mockImplementation(
      async (algorithm, data) => {
        const result = await realDigest(algorithm, data);
        if (first) {
          first = false;
          reached();
          await resume;
        }
        return result;
      },
    );
    const verification = loader.verify(a).then(
      (value) => ({ value, error: undefined }),
      (error) => ({ value: undefined, error }),
    );
    try {
      await paused;
      if (stale === "success") loader.clear();
      const b = await loader.get(origin, uri);
      const lease = await loader.activate(b);
      lease.assertExecutionApproved();
      release();
      const outcome = await verification;
      expect(outcome.error).toBeInstanceOf(Error);
      expect(outcome.value).toBeUndefined();
      lease.assertExecutionApproved();
      expect((await lease.read(uri)).bytes).toEqual(bytes);
      await loader.activate(b);
      expect(approvals).toBe(1);
    } finally {
      release();
      await verification;
      spy.mockRestore();
    }
  });
}

test("mutating a skill during hold does not reuse the prior execution approval", async () => {
  const uri = "skill://demo/SKILL.md";
  const bytes = new TextEncoder().encode(
    "---\nname: demo\ndescription: Correct\n---\nInstructions",
  );
  const mutated = new TextEncoder().encode(
    "---\nname: demo\ndescription: Mutated\n---\nInstructions",
  );
  const publisher = await createSkillPublisher([
    { uri, files: new Map([[uri, bytes]]) },
  ]);
  const origin: McpSkillOrigin = {
    serverId: "server",
    tenantId: "tenant",
    principalId: "principal",
    authorizationContextId: "auth",
  };
  let approvals = 0;
  let payload = bytes;
  const host: McpSkillHostPolicy = {
    async approve(held) {
      approvals++;
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
  const source: SkillSource = {
    async get() {
      return publisher.get(uri).skill;
    },
    async read() {
      return payload.slice();
    },
  };
  const loader = createSkillLoader(source, host);
  const entry = publisher.get(uri).skill;
  const lease = await loader.activate(await loader.hold(origin, entry));
  lease.assertExecutionApproved();
  const digestBytes = await crypto.subtle.digest("SHA-256", mutated);
  const mutatedDigest = `sha256:${Array.from(new Uint8Array(digestBytes), (b) => b.toString(16).padStart(2, "0")).join("")}`;
  let reached!: () => void;
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  const realDigest = crypto.subtle.digest.bind(crypto.subtle);
  let arm = true;
  const spy = spyOn(crypto.subtle, "digest").mockImplementation(
    async (algorithm, data) => {
      const result = await realDigest(algorithm, data);
      if (arm) {
        arm = false;
        reached();
        await resume;
      }
      return result;
    },
  );
  const pending = loader.hold(origin, entry).then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
  try {
    await paused;
    if (entry.resources === "dynamic") throw new Error("fixture");
    const resource = entry.resources.find((file) => file.uri === uri);
    if (!resource) throw new Error("fixture");
    entry.frontmatter.description = "Mutated";
    resource.digest = mutatedDigest;
    resource.size = mutated.byteLength;
    payload = mutated;
    release();
    const held = await pending;
    expect(held.error).toBeUndefined();
    if (!held.value || held.value.entry.resources === "dynamic")
      throw new Error("fixture");
    expect(held.value.entry.frontmatter.description).toBe("Correct");
    expect(
      held.value.entry.resources.find((file) => file.uri === uri)?.digest,
    ).not.toBe(mutatedDigest);
    expect(() => lease.assertExecutionApproved()).toThrow("revoked");
    const replacement = await loader.activate(held.value);
    replacement.assertExecutionApproved();
    expect((await replacement.read(uri)).bytes).toEqual(bytes);
    expect(approvals).toBe(2);
  } finally {
    release();
    await pending;
    spy.mockRestore();
  }
});
