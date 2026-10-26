import packageManifest from "../package.json";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
let sandbox: string;
let hostSandbox: string;

async function command(argv: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(`${argv.join(" ")} exited ${code}\n${stdout}\n${stderr}`);
  return stdout;
}

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "corbits-mcp-package-"));
  await command(["bun", "run", "build"], root);
  await command(
    ["bun", "pm", "pack", "--ignore-scripts", "--destination", sandbox],
    root,
  );
  await writeFile(
    join(sandbox, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  await command(
    [
      "npm",
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(sandbox, `corbits-mcp-${packageManifest.version}.tgz`),
    ],
    sandbox,
  );
  hostSandbox = await mkdtemp(join(tmpdir(), "corbits-mcp-host-package-"));
  await writeFile(
    join(hostSandbox, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  const peers = Object.entries(packageManifest.devDependencies)
    .filter(([name]) => name === "@intx/agent" || name === "@intx/harness")
    .map(([name, version]) => `${name}@${version}`);
  await command(
    [
      "npm",
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(sandbox, `corbits-mcp-${packageManifest.version}.tgz`),
      ...peers,
      "@corbits/oauth-core@0.3.3",
    ],
    hostSandbox,
  );
}, 180_000);

afterAll(async () => {
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
  if (hostSandbox) await rm(hostSandbox, { recursive: true, force: true });
}, 30_000);

test("packed exports retain the four roles and historical facades", async () => {
  const manifest = JSON.parse(
    await readFile(
      join(sandbox, "node_modules/@corbits/mcp/package.json"),
      "utf8",
    ),
  );
  expect(manifest.dependencies["@corbits/oauth-core"]).toBeUndefined();
  expect(manifest.peerDependencies["@corbits/oauth-core"]).toBe("^0.3.3");
  expect(manifest.peerDependenciesMeta["@corbits/oauth-core"]).toEqual({
    optional: true,
  });
  for (const entry of [
    ".",
    "./client",
    "./server",
    "./server/task-store",
    "./interchange/client",
    "./interchange/server",
    "./hub",
    "./sidecar-bundle",
  ]) {
    const target = manifest.exports[entry];
    expect(target).toBeDefined();
    expect(
      (
        await readFile(
          join(sandbox, "node_modules/@corbits/mcp", target.types),
          "utf8",
        )
      ).length,
    ).toBeGreaterThan(0);
    expect(
      (
        await readFile(
          join(sandbox, "node_modules/@corbits/mcp", target.default),
          "utf8",
        )
      ).length,
    ).toBeGreaterThan(0);
  }
});

for (const runtime of ["bun", "node"]) {
  test(`packed standalone entries load without host peers under ${runtime}`, async () => {
    const script = `
      import assert from "node:assert/strict";
      import { createRequire } from "node:module";
      import { mcpConnect, mcpCallTool } from "@corbits/mcp/client";
      import { createMcpServer } from "@corbits/mcp/server";
      const require = createRequire(import.meta.url);
      for (const dependency of ["@corbits/oauth-core", "@intx/agent", "@intx/harness", "@intx/db", "@intx/hub-api", "@intx/hub-common", "hono", "@modelcontextprotocol/sdk"]) {
        assert.throws(() => require.resolve(dependency), { code: "MODULE_NOT_FOUND" }, "Unexpected installed host dependency: " + dependency);
      }
      assert.equal(typeof mcpConnect, "function");
      assert.equal(typeof mcpCallTool, "function");
      assert.equal(typeof createMcpServer, "function");
      if (process.release.name === "node" && !process.versions.bun) assert.ok(Number(process.versions.node.split(".")[0]) >= 24);
      console.log("isolated imports passed");
    `;
    await writeFile(join(sandbox, "smoke.mjs"), script);
    expect(await command([runtime, "smoke.mjs"], sandbox)).toContain(
      "isolated imports passed",
    );
  }, 30_000);
}

for (const runtime of ["bun", "node"]) {
  for (const role of ["standalone", "host", "auth", "legacy"] as const) {
    test(`packed ${role} factories execute through public APIs under ${runtime}`, async () => {
      const directory =
        role === "standalone" || role === "legacy" ? sandbox : hostSandbox;
      const script = await readFile(
        new URL(`./fixtures/packed-${role}.mjs`, import.meta.url),
        "utf8",
      );
      await writeFile(join(directory, `${role}.mjs`), script);
      expect(await command([runtime, `${role}.mjs`], directory)).toContain(
        role === "standalone"
          ? "packed standalone lifecycle passed"
          : `packed ${role} APIs passed`,
      );
    }, 30_000);
  }
}

for (const role of ["client", "server"]) {
  test(`packed neutral ${role} graph excludes filesystem and host runtimes`, async () => {
    await writeFile(
      join(sandbox, "client-entry.mjs"),
      `import * as entry from "@corbits/mcp/${role}"; console.log(Object.keys(entry));`,
    );
    await writeFile(
      join(sandbox, "client-boundary.mjs"),
      `
    import assert from "node:assert/strict";
    const result = await Bun.build({
      entrypoints: ["./client-entry.mjs"], target: "bun", write: false,
      plugins: [{ name: "neutral-${role}-boundary", setup(build) {
        build.onResolve({ filter: /^(?:node:)?(?:fs|path)$|^(?:node:)?fs\\/|^@intx\\/|^@corbits\\/(?:oauth-core|credential-http)|^hono(?:\\/|$)|file-store/ }, args => {
          throw new Error("Forbidden neutral-${role} dependency: " + args.path);
        });
      }}],
    });
    assert.equal(result.success, true, result.logs.map(String).join("\\n"));
    console.log("neutral client graph passed");
  `,
    );
    expect(await command(["bun", "client-boundary.mjs"], sandbox)).toContain(
      "neutral client graph passed",
    );
  });
}
