/** Explicit server-only import. Not re-exported by the neutral extensions entry. */
import { open, mkdir, rename, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { type } from "arktype";
import type { McpTaskRecord, McpTaskStore } from "./contracts.js";

const envelope = type({ version: "1", records: "unknown[]" });
const MAX_STORE_BYTES = 16_777_216;
/** Single writer on a local filesystem only. A crash leaves the lock: host must
 * prove the previous writer dead before removing it. Never auto-steal a lock.
 * Directory must be host-owned, not writable by models/tools/other users.
 */
export async function createFileTaskStore(options: {
  directory: string;
  /** Shared boundary validation plus host record invariants on restart. */
  validateRecord(value: unknown): McpTaskRecord;
}): Promise<McpTaskStore & { close(): Promise<void> }> {
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const directoryStat = await stat(options.directory);
  if ((directoryStat.mode & 0o077) !== 0)
    throw new Error("Task directory must be private (0700)");
  const lockPath = join(options.directory, "writer.lock");
  const lock = await open(lockPath, "wx", 0o600);
  const dataPath = join(options.directory, "tasks.json");
  let records = new Map<string, McpTaskRecord>();
  let closed = false;
  let closing: Promise<void> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(run: () => Promise<T>): Promise<T> => {
    if (closing) return Promise.reject(new Error("Task store closed"));
    const result = queue.then(() => {
      if (closed) throw new Error("Task store closed");
      return run();
    });
    queue = result.catch(() => {});
    return result;
  };
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    await lock.sync();
    let file;
    try {
      file = await open(dataPath, "r");
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
    if (file)
      try {
        if ((await file.stat()).size > MAX_STORE_BYTES)
          throw new Error("Task store exceeds 16 MiB");
        const parsed = envelope(
          JSON.parse(await file.readFile("utf8")) as unknown,
        );
        if (parsed instanceof type.errors)
          throw new Error("Invalid task store envelope");
        for (const value of parsed.records) {
          const record = options.validateRecord(value);
          if (records.has(record.task.taskId))
            throw new Error("Duplicate persisted task");
          records.set(record.task.taskId, structuredClone(record));
        }
      } finally {
        await file.close();
      }
  } catch (error) {
    await lock.close();
    await unlink(lockPath);
    throw error;
  }
  async function persist(next: Map<string, McpTaskRecord>): Promise<void> {
    const bytes = JSON.stringify({ version: 1, records: [...next.values()] });
    if (Buffer.byteLength(bytes) > MAX_STORE_BYTES)
      throw new Error("Task store exceeds 16 MiB");
    const tempPath = join(
      options.directory,
      `tasks-${crypto.randomUUID()}.tmp`,
    );
    const temp = await open(tempPath, "wx", 0o600);
    try {
      await temp.writeFile(bytes);
      await temp.sync();
    } finally {
      await temp.close();
    }
    try {
      await rename(tempPath, dataPath);
      const directory = await open(options.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      records = next;
    } catch (error) {
      // An ambiguous durability failure poisons this writer; restart reconciles disk.
      closed = true;
      throw error;
    }
  }
  return {
    durable: true,
    create(record) {
      return serialized(async () => {
        if (records.has(record.task.taskId) || record.revision !== 0)
          throw new Error("Task exists or invalid initial revision");
        const checked = options.validateRecord(structuredClone(record));
        const next = new Map(records);
        next.set(record.task.taskId, checked);
        await persist(next);
      });
    },
    get(taskId) {
      return serialized(async () => structuredClone(records.get(taskId)));
    },
    compareAndSwap(taskId, revision, record) {
      return serialized(async () => {
        const current = records.get(taskId);
        if (!current || current.revision !== revision) return false;
        if (
          record.task.taskId !== taskId ||
          record.revision !== revision + 1 ||
          JSON.stringify(record.identity) !== JSON.stringify(current.identity)
        )
          throw new Error("Invalid task CAS identity/revision");
        const checked = options.validateRecord(structuredClone(record));
        const next = new Map(records);
        next.set(taskId, checked);
        await persist(next);
        return true;
      });
    },
    list() {
      return serialized(async () => structuredClone([...records.values()]));
    },
    expire(now) {
      return serialized(async () => {
        const next = new Map(
          [...records].filter(
            ([, r]) =>
              r.task.ttlMs === null ||
              Date.parse(r.task.createdAt) + r.task.ttlMs > now,
          ),
        );
        if (next.size !== records.size) await persist(next);
      });
    },
    close() {
      // Publish the close promise synchronously: reject new operations while
      // draining accepted ones, and never unlink a successor's lock on retry.
      closing ??= (async () => {
        await queue;
        closed = true;
        await lock.close();
        await unlink(lockPath);
      })();
      return closing;
    },
  };
}
