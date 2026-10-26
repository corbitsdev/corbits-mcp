import { mcpCallTool, mcpConnect, mcpListTools } from "@corbits/mcp/client";

const url = process.argv[2];
const name = process.argv[3];
if (!url || !name) throw new Error("Usage: standalone-client.ts <url> <tool>");
const session = await mcpConnect(url);
console.log(await mcpListTools(url, { session }));
const result = await mcpCallTool(url, name, { text: "hello" }, { session });
if (result.resultType === "input_required" || result.resultType === "task") {
  throw new Error(
    "This minimal example has no elicitation or task host services",
  );
}
console.log(result.content);
