export function rpc(
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Request {
  const name = params.name ?? params.uri ?? params.taskId;
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": method,
      ...(typeof name === "string" ? { "Mcp-Name": name } : {}),
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
          ...(params._meta as object),
        },
      },
    }),
  });
}
export async function result(
  response: Response,
): Promise<Record<string, unknown>> {
  if (response.headers.get("content-type")?.includes("application/json"))
    return (await response.json()) as Record<string, unknown>;
  const events = (await response.text()).trim().split("\n\n");
  return JSON.parse(events.at(-1)!.slice(6));
}
