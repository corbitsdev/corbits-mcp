# Contributing

## Design: split discovery and calling

Discovery and calling are split, because a deployed agent's tool factories
are evaluated synchronously when the agent is constructed and the agent must
never hold a server's bearer.

1. **The deployer discovers the catalog once**, server-side, through the hub
   route this package mounts. The browser never holds an MCP token, so this
   is the only way an OAuth-protected server's `tools/list` can be read.
2. **The catalog is stored** with the rest of the agent's deploy config.
3. **`mcpServers` turns it into tools.** It is synchronous and does no
   network work at construction: the names and the `ask` marks come from the
   stored catalog.
4. **At run time the agent only ever sees a mediated handle.** Each server's
   credential resolves to an `http` handle -- a fetch pinned to that server's
   origin that injects the bearer per request -- so the token never reaches
   agent code, and a relative path is all the bundle ever asks for.
