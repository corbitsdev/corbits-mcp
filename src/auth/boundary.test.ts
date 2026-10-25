import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

for (const entry of ["./resource-server.ts", "../server.ts"]) {
  test(`${entry} runtime graph excludes OAuth, Hono and DB integrations`, async () => {
    const forbidden: string[] = [];
    const result = await Bun.build({
      entrypoints: [fileURLToPath(new URL(entry, import.meta.url))],
      target: "bun",
      plugins: [
        {
          name: "neutral-server-boundary",
          setup(build) {
            build.onResolve(
              {
                filter:
                  /^(?:@corbits\/oauth-core|hono|@intx\/(?:db|hub-api)|drizzle-orm)(?:\/|$)/,
              },
              (args) => {
                forbidden.push(args.path);
                return { path: args.path, external: true };
              },
            );
          },
        },
      ],
    });
    expect(result.success).toBe(true);
    expect(forbidden).toEqual([]);
  });
}
