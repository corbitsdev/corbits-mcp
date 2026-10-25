import { parseDocument, visit, isAlias } from "yaml";
import { type } from "arktype";
import { validateSkill } from "../../protocol/index.js";
import type { Skill } from "../../protocol/index.js";
import type {
  HeldSkill,
  McpSkillHostPolicy,
  McpSkillOrigin,
  SkillApprovalReceipt,
  SkillLease,
  SkillSource,
  VerifiedSkillBytes,
} from "./contracts.js";
export type * from "./contracts.js";

export const SKILL_LIMITS = Object.freeze({
  resources: 512,
  bytes: 16_777_216,
});
const frontmatterShape = type({ name: "string", description: "string" });
const fail = (message: string): never => {
  throw Object.assign(new Error(message), { code: -32602 });
};
const encoder = new TextEncoder();
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? fail("Non-JSON frontmatter");
};
async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return `sha256:${Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
function safeUri(uri: string): void {
  const parsed = new URL(uri);
  if (
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password ||
    /[\\\s]/u.test(uri)
  )
    fail("Unsafe skill URI");
  const segments = uri.slice(uri.indexOf(":") + 1).split("/");
  for (const segment of segments) {
    const decoded = decodeURIComponent(segment);
    if (
      decoded === "." ||
      decoded === ".." ||
      /[/\\]/u.test(decoded) ||
      decoded.includes(String.fromCharCode(0))
    )
      fail("Unsafe skill path");
  }
}
function checkFrontmatter(value: unknown, uri: string): Skill["frontmatter"] {
  const parsed = frontmatterShape(value);
  if (parsed instanceof type.errors) return fail("Invalid skill frontmatter");
  const { name, description } = parsed;
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) ||
    name.length > 64 ||
    !description.trim() ||
    description.length > 1024
  )
    fail("Invalid skill name or description");
  if (!uri.endsWith(`/${name}/SKILL.md`))
    fail("Skill name does not match directory");
  const fm = value as Skill["frontmatter"];
  if (
    fm.compatibility !== undefined &&
    (typeof fm.compatibility !== "string" ||
      !fm.compatibility.length ||
      fm.compatibility.length > 500)
  )
    fail("Invalid compatibility");
  for (const key of ["license", "allowed-tools"])
    if (fm[key] !== undefined && typeof fm[key] !== "string")
      fail(`Invalid ${key}`);
  if (
    fm.metadata !== undefined &&
    (fm.metadata === null ||
      typeof fm.metadata !== "object" ||
      Array.isArray(fm.metadata) ||
      Object.values(fm.metadata).some((v) => typeof v !== "string"))
  )
    fail("Invalid metadata");
  return fm;
}
export function parseSkillFrontmatter(
  bytes: Uint8Array,
  uri: string,
): Skill["frontmatter"] {
  if (bytes.byteLength > SKILL_LIMITS.bytes) fail("Skill exceeds 16 MiB");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  if (!match) return fail("Missing YAML frontmatter");
  // Bound parser nesting before conversion, and prohibit aliases entirely.
  const doc = parseDocument(match[1]!, { schema: "core", uniqueKeys: true });
  if (doc.errors.length) fail("Invalid YAML frontmatter");
  let nodes = 0;
  visit(doc, (_key, node, path) => {
    if (isAlias(node) || path.length > 32 || ++nodes > 100_000)
      fail("Frontmatter structure limit or alias");
  });
  const value: unknown = doc.toJS({ maxAliasCount: 0 });
  const inspect = (v: unknown, depth: number): void => {
    if (depth > 32) fail("Frontmatter nesting limit");
    if (v !== null && typeof v === "object")
      for (const child of Object.values(v)) inspect(child, depth + 1);
    else if (!["string", "number", "boolean"].includes(typeof v) && v !== null)
      fail("Non-JSON frontmatter");
    if (typeof v === "number" && !Number.isFinite(v)) fail("Non-JSON number");
  };
  inspect(value, 0);
  return checkFrontmatter(value, uri);
}
function checkEntry(entry: Skill): void {
  validateSkill(entry);
  safeUri(entry.uri);
  checkFrontmatter(entry.frontmatter, entry.uri);
  if (entry.resources === "dynamic")
    return fail("Dynamic skills cannot be content-bound and are not supported");
  if (
    !Array.isArray(entry.resources) ||
    entry.resources.length > SKILL_LIMITS.resources
  )
    fail("Skill exceeds 512 resources or lacks manifest");
  const root = entry.uri.slice(0, -"SKILL.md".length);
  let total = 0;
  for (const file of entry.resources) {
    safeUri(file.uri);
    if (!file.uri.startsWith(root) || file.uri.endsWith("/"))
      fail("Manifest has duplicate or out-of-directory file");
    total += file.size;
  }
  if (total > SKILL_LIMITS.bytes) fail("Skill exceeds 16 MiB");
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function createSkillLoader(
  source: SkillSource,
  host?: McpSkillHostPolicy,
) {
  const heldEntries = new WeakMap<HeldSkill, object>();
  const current = new Map<
    string,
    { fingerprint: string; generation: object }
  >();
  const approvals = new Map<string, SkillApprovalReceipt>();
  const cache = new Map<string, Uint8Array>();
  let cacheBytes = 0;
  async function hold(
    origin: McpSkillOrigin,
    entry: Skill,
  ): Promise<HeldSkill> {
    if (Object.values(origin).some((v) => !v))
      fail("Host origin identity required");
    checkEntry(entry);
    const identity = canonical([
      origin.serverId,
      origin.tenantId,
      origin.principalId,
      origin.authorizationContextId,
      entry.uri,
    ]);
    const resources = entry.resources;
    if (resources === "dynamic") return fail("Dynamic skills unsupported");
    const fingerprint = await digest(
      encoder.encode(
        canonical({
          frontmatter: entry.frontmatter,
          resources: [...resources].sort((a, b) => a.uri.localeCompare(b.uri)),
        }),
      ),
    );
    if (current.get(identity)?.fingerprint !== fingerprint) {
      approvals.delete(identity);
      current.set(identity, { fingerprint, generation: {} });
    }
    const generation = current.get(identity)!.generation;
    const held: HeldSkill = freeze({
      origin: structuredClone(origin),
      entry: structuredClone(entry),
      identity,
      fingerprint,
    });
    heldEntries.set(held, generation);
    return held;
  }
  function assertCurrent(held: HeldSkill): void {
    if (
      !heldEntries.has(held) ||
      current.get(held.identity)?.generation !== heldEntries.get(held)
    )
      fail("Skill entry revoked; refresh and reapprove");
  }
  async function verify(
    held: HeldSkill,
    uri = held.entry.uri,
  ): Promise<VerifiedSkillBytes> {
    assertCurrent(held);
    try {
      const files = held.entry.resources;
      if (files === "dynamic") return fail("Dynamic skills unsupported");
      const file = files.find((f) => f.uri === uri);
      if (!file) return fail("Unlisted skill file");
      const key = canonical([held.identity, uri, file.digest]);
      const bytes = new Uint8Array(
        cache.get(key) ?? (await source.read(held.origin, uri, file.size)),
      );
      assertCurrent(held);
      if (bytes.byteLength !== file.size)
        return fail("Skill integrity mismatch");
      const actualDigest = await digest(bytes);
      // A source read or digest can finish after refresh/clear. Reject stale
      // work before parsing frontmatter, changing the cache, or exposing bytes.
      assertCurrent(held);
      if (actualDigest !== file.digest) {
        cache.delete(key);
        return fail("Skill integrity mismatch");
      }
      if (
        uri === held.entry.uri &&
        canonical(parseSkillFrontmatter(bytes, uri)) !==
          canonical(held.entry.frontmatter)
      )
        return fail("Skill frontmatter mismatch");
      if (!cache.has(key)) {
        if (cacheBytes + bytes.length > SKILL_LIMITS.bytes) {
          cache.clear();
          cacheBytes = 0;
        }
        cache.set(key, bytes.slice());
        cacheBytes += bytes.length;
      }
      return { held, uri, bytes, trust: "untrusted-mcp" };
    } catch (error) {
      // Every verification failure, including source, digest and YAML errors,
      // may invalidate only the generation that initiated this verification.
      if (current.get(held.identity)?.generation === heldEntries.get(held)) {
        approvals.delete(held.identity);
        current.delete(held.identity);
      }
      throw error;
    }
  }

  async function activate(held: HeldSkill): Promise<SkillLease> {
    assertCurrent(held);
    if (!host)
      return fail(
        "Skill host policy unavailable; verified bytes are not activation",
      );
    let approval = approvals.get(held.identity);
    if (!approval) {
      approval = await host.approve(held);
      if (
        approval.approved !== true ||
        approval.identity !== held.identity ||
        approval.fingerprint !== held.fingerprint
      )
        return fail("Skill approval denied or mismatched");
      approval = freeze(structuredClone(approval));
      assertCurrent(held);
      approvals.set(held.identity, approval);
    }
    const content = await verify(held);
    let active = true;
    const assertExecutionApproved = () => {
      assertCurrent(held);
      if (!active || !approvals.get(held.identity)?.execution)
        fail("Explicit per-skill execution approval required");
    };
    const window = await host.openActingWindow(held, approval, {
      assertExecutionApproved,
    });
    try {
      assertCurrent(held);
      await window.admit(content);
    } catch (error) {
      await window.removeContext();
      await window.close();
      throw error;
    }
    return {
      held,
      read: (uri) => {
        if (!active) return Promise.reject(new Error("Skill lease closed"));
        return verify(held, uri);
      },
      assertExecutionApproved,
      async release() {
        if (active) {
          await window.removeContext();
          await window.close();
          active = false;
        }
      },
    };
  }
  return {
    hold,
    verify,
    activate,
    async get(origin: McpSkillOrigin, uri: string) {
      const entry = await source.get(origin, uri);
      if (entry.uri !== uri) return fail("Skill URI mismatch");
      return hold(origin, entry);
    },
    clear() {
      cache.clear();
      cacheBytes = 0;
      approvals.clear();
      current.clear();
    },
  };
}

/** In-memory immutable snapshot publisher. Host must authorize all methods using the same identity. */
export async function createSkillPublisher(
  publications: readonly {
    uri: string;
    files: ReadonlyMap<string, Uint8Array>;
  }[],
) {
  const skills = new Map<string, Skill>();
  const files = new Map<string, Uint8Array>();
  for (const original of publications) {
    const publication = {
      uri: original.uri,
      files: new Map(
        [...original.files].map(([uri, bytes]) => [uri, bytes.slice()]),
      ),
    };
    if (skills.has(publication.uri)) fail("Duplicate skill publication");
    const main = publication.files.get(publication.uri);
    if (!main) return fail("Publication omits SKILL.md");
    const resources = await Promise.all(
      [...publication.files].map(async ([uri, bytes]) => ({
        uri,
        digest: await digest(bytes),
        size: bytes.length,
      })),
    );
    const entry: Skill = {
      uri: publication.uri,
      frontmatter: parseSkillFrontmatter(main, publication.uri),
      resources,
    };
    checkEntry(entry);
    skills.set(entry.uri, entry);
    for (const [uri, bytes] of publication.files) {
      const previous = files.get(uri);
      if (previous && (await digest(previous)) !== (await digest(bytes)))
        fail("Conflicting nested publication");
      files.set(uri, bytes.slice());
    }
  }
  for (const skill of skills.values()) {
    const root = skill.uri.slice(0, -"SKILL.md".length);
    if (skill.resources !== "dynamic")
      for (const uri of files.keys())
        if (
          uri.startsWith(root) &&
          !skill.resources.some((file) => file.uri === uri)
        )
          fail("Incomplete enclosing skill manifest");
  }
  return {
    list() {
      return {
        resultType: "complete" as const,
        ttlMs: 0,
        cacheScope: "private" as const,
        skills: structuredClone([...skills.values()]),
      };
    },
    get(uri: string) {
      const skill = skills.get(uri);
      if (!skill) return fail("Unknown skill");
      return {
        resultType: "complete" as const,
        ttlMs: 0,
        cacheScope: "private" as const,
        skill: structuredClone(skill),
      };
    },
    read(uri: string) {
      const bytes = files.get(uri);
      if (!bytes) return fail("Unknown resource");
      return {
        resultType: "complete" as const,
        ttlMs: 0,
        cacheScope: "private" as const,
        contents: [{ uri, blob: Buffer.from(bytes).toString("base64") }],
      };
    },
    directoryRead(uri: string) {
      safeUri(uri);
      if (uri.endsWith("/")) fail("Directory URI must not end in slash");
      const children = new Map<
        string,
        { uri: string; name: string; mimeType?: string }
      >();
      for (const file of files.keys())
        if (file.startsWith(`${uri}/`)) {
          const relative = file.slice(uri.length + 1);
          const name = relative.split("/")[0]!;
          children.set(name, {
            uri: `${uri}/${name}`,
            name,
            ...(relative.includes("/") ? { mimeType: "inode/directory" } : {}),
          });
        }
      if (!children.size) return fail("Unknown directory");
      return {
        resultType: "complete" as const,
        ttlMs: 0,
        cacheScope: "private" as const,
        resources: [...children.values()],
      };
    },
  };
}
