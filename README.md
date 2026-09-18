# @corbits/mcp

An MCP client tool package for Interchange: streamable HTTP transport
(2025-03-26 spec), one `@intx/agent` tool per remote tool, and no gate of
its own -- Interchange's native per-tool grant checks the whole surface.

## Usage

```ts
import { mcpTools } from "@corbits/mcp";
import { defineAgent } from "@intx/agent";

const linear = await mcpTools({
  servers: [{ name: "linear", url: "https://mcp.linear.app/mcp" }],
});

defineAgent({
  id: "my-agent",
  systemPrompt: "...",
  tools: [linear],
  capabilities: [],
  inference: { sources: [] },
});
```

Each remote tool becomes an agent tool named `<server>.<tool>` (e.g.
`linear.list_issues`), with the remote `inputSchema` passed through
verbatim and its call proxied to `tools/call`. `mcpTools` is called
directly in agent-authoring code, the same way `tools/linear`'s
`linearTools` is -- not through the sidecar's dynamic package loader,
which requires a package's entry to already be a built factory and so
can't accommodate this discovery step.

## Grants

Interchange checks every tool call as resource `tool:<name>`, most
specific match wins, `deny` beats `ask` beats `allow`
(`vendor/intx/inference/src/authz-extension.ts`). Because each remote
tool is its own agent tool, `tool:<server>.<tool>` is grantable
individually and `tool:<server>.*` covers a whole server.

Two knobs, both in `mcpTools(options)`:

- **Grant effect** -- an operator's `allow`/`deny`/`ask` grant on
  `tool:<server>.<tool>` or `tool:<server>.*`, set the normal Interchange
  way (roles, invoker delegation, etc). This library never writes grants.
- **`allowWithoutAsk`** -- every generated tool is `ask`-marked by
  default; listing `"<server>.<tool>"` here is the _only_ way to lower
  that mark, and it is ignored for any remote tool the server flags
  `destructiveHint: true`.

A server that needs auth declares `credentialHandle: "mcp-server"`
(the handle this package declares in `interchange.credentials`), so the
resulting `credential:<id>` / `use` grant binds the token to
`@corbits/mcp` only -- no other tool package can resolve it.

## License

LGPL-2.1-only.
