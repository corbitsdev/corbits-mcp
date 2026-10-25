# Examples

These examples use public entry points after building/installing the package.

- `standalone-client.ts`: discover and call an explicitly named remote tool.
- `standalone-server.ts`: intentionally public loopback echo server. Do not expose
  sensitive operations with `auth: "public"`; install a validated auth policy and
  explicit allowed origins when deploying an authenticated service.
- `../e2e/interchange.test.ts`: executable bidirectional example using installed
  Interchange `defineTool`, `createToolRunner`, HTTP credential provider and
  credential capability. It exposes one selected tool (not the entire bundle),
  calls it through standalone MCP, consumes it back into a real tool factory,
  and asserts schema/authorization/approval failures do not execute it. It does
  not simulate an inference reactor or certify workflow/task lifecycle support.

```sh
bun run build
bun examples/standalone-server.ts
# In another terminal:
bun examples/standalone-client.ts http://127.0.0.1:3000/mcp echo
```

For an authenticated host, compose `createInterchangeProviders({ auth, exposures })`
into `createMcpServer({ serverInfo, auth, providers })`. Each exposure supplies a
host-bound tenant, operation resource/action, explicit approval callback and a
selected tool/agent/HTTP/workflow binding. Never derive identity or fixed tenant
paths from model arguments. See the [migration guide](../docs/migration.md) for
required host services and cancellation/durability limits.
