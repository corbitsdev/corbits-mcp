import { expect, spyOn, test } from "bun:test";
import { createSkillLoader, createSkillPublisher } from "./index.js";
import type { McpSkillHostPolicy } from "./contracts.js";

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
