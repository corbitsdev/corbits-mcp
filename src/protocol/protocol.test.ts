import { describe, expect, test } from "bun:test";
import {
  MCP_EXT_SKILLS,
  MCP_EXT_TASKS,
  MCP_EXT_UI,
  MCP_PROTOCOL_VERSION,
  McpError,
  McpErrorCode,
  encodeHeaderValue,
  decodeHeaderValue,
  validateRequestHeaders,
  validateRequest,
  validateResult,
  validateNotification,
  validateSchema,
  validateInstance,
  validateSkill,
  negotiateExtensions,
  collectHeaderSlots,
} from "./index";
const metadata = {
  "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientCapabilities": {},
};
const task = {
  taskId: "task",
  status: "working",
  createdAt: "2026-07-28T00:00:00Z",
  lastUpdatedAt: "2026-07-28T00:00:00Z",
  ttlMs: null,
};
const tasks = { extensions: [MCP_EXT_TASKS] };
describe("shared normative contracts", () => {
  test("MRTR and tasks are eligible only on pinned methods", () => {
    for (const method of ["tools/call", "prompts/get", "resources/read"])
      expect(
        validateResult(method, {
          resultType: "input_required",
          requestState: "",
        }),
      ).toHaveProperty("requestState", "");
    for (const method of [
      "tools/list",
      "completion/complete",
      "subscriptions/listen",
    ])
      expect(() =>
        validateResult(method, {
          resultType: "input_required",
          requestState: "s",
        }),
      ).toThrow(McpError);
    expect(
      validateResult("tools/call", { ...task, resultType: "task" }, tasks),
    ).toHaveProperty("taskId", "task");
    for (const method of ["prompts/get", "resources/read", "tasks/get"])
      expect(() =>
        validateResult(method, { ...task, resultType: "task" }, tasks),
      ).toThrow(McpError);
    expect(() =>
      validateResult(
        "tools/call",
        { ...task, resultType: "task" },
        { ...tasks, era: "legacy" },
      ),
    ).toThrow(McpError);
    expect(() =>
      validateResult("subscriptions/listen", { resultType: "future" }),
    ).toThrow(McpError);
  });
  test("tasks require status payloads and bounded integer durations", () => {
    expect(
      validateResult("tasks/get", { ...task, resultType: "complete" }, tasks),
    ).toHaveProperty("ttlMs", null);
    for (const status of ["input_required", "completed", "failed"])
      expect(() =>
        validateResult("tasks/get", { ...task, status }, tasks),
      ).toThrow(McpError);
    for (const ttlMs of [-1, 0.1, Infinity])
      expect(() =>
        validateResult(
          "tools/call",
          { ...task, ttlMs, resultType: "task" },
          tasks,
        ),
      ).toThrow(McpError);
    expect(() =>
      validateResult(
        "tasks/get",
        {
          ...task,
          status: "completed",
          result: { resultType: "task", ...task },
        },
        tasks,
      ),
    ).toThrow(McpError);
  });
  test("form and URL elicitation validate, unsupported deprecated inputs fail safely", () => {
    const form = {
      method: "elicitation/create",
      params: {
        message: "Name",
        requestedSchema: {
          type: "object",
          properties: { name: { type: "string" } },
        },
      },
    };
    const url = {
      method: "elicitation/create",
      params: {
        mode: "url",
        message: "Sign in",
        url: "https://example.test/login",
      },
    };
    for (const input of [form, url])
      expect(
        validateResult("tools/call", {
          resultType: "input_required",
          inputRequests: { key: input },
        }),
      ).toHaveProperty("inputRequests.key", input);
    expect(() =>
      validateResult("tools/call", {
        resultType: "input_required",
        inputRequests: { key: { method: "roots/list" } },
      }),
    ).toThrow(McpError);
    expect(() =>
      validateResult(
        "tools/call",
        { resultType: "input_required", inputRequests: { key: form } },
        { clientCapabilities: {} },
      ),
    ).toThrow("capability");
    expect(() =>
      validateRequest(
        "tasks/update",
        {
          taskId: "t",
          inputResponses: { key: { action: "yes" } },
          _meta: metadata,
        },
        tasks,
      ),
    ).toThrow("action");
  });
  test("wire validation preserves extension metadata and rejects nonobjects", () => {
    const result = {
      content: [],
      _meta: { "example/trace": { arbitrary: true } },
    };
    expect(validateResult("tools/call", result)).toBe(result);
    for (const result of [null, [], 1, "ok"])
      expect(() => validateResult("tools/call", result)).toThrow(McpError);
    expect(() =>
      validateNotification("notifications/progress", {
        progressToken: 1,
        progress: Infinity,
      }),
    ).toThrow(McpError);
  });
  test("all task methods use taskId and encoded headers round trip", () => {
    for (const name of [
      "",
      "plain",
      " 日本語 ",
      "=?base64?abc?=",
      "line\nbreak",
    ])
      expect(decodeHeaderValue(encodeHeaderValue(name))).toBe(name);
    for (const method of ["tasks/get", "tasks/update", "tasks/cancel"]) {
      const params = { taskId: "日本語", _meta: metadata };
      const headers = new Headers({
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        "Mcp-Method": method,
        "Mcp-Name": encodeHeaderValue(params.taskId),
      });
      expect(() =>
        validateRequestHeaders(headers, method, params, tasks),
      ).not.toThrow();
      headers.set("Mcp-Name", "other");
      try {
        validateRequestHeaders(headers, method, params, tasks);
        throw new Error("expected mismatch");
      } catch (error) {
        expect((error as McpError).code).toBe(McpErrorCode.HeaderMismatch);
      }
    }
  });
  test("header annotations reject ambiguous or unreachable mappings", () => {
    expect(() =>
      collectHeaderSlots({
        type: "object",
        anyOf: [
          {
            properties: { value: { type: "string", "x-mcp-header": "Value" } },
          },
        ],
      }),
    ).toThrow(McpError);
    expect(() =>
      collectHeaderSlots({
        properties: {
          a: { type: "string", "x-mcp-header": "X" },
          b: { type: "string", "x-mcp-header": "x" },
        },
      }),
    ).toThrow(McpError);
  });
  test("extension negotiation is explicit and settings are validated", () => {
    expect(negotiateExtensions({}, { [MCP_EXT_TASKS]: {} })).toEqual({});
    expect(
      negotiateExtensions(
        {
          [MCP_EXT_SKILLS]: {},
          [MCP_EXT_UI]: { mimeTypes: ["text/html;profile=mcp-app"] },
        },
        {
          [MCP_EXT_SKILLS]: { directoryRead: true },
          [MCP_EXT_UI]: { mimeTypes: ["text/html;profile=mcp-app"] },
        },
      ),
    ).toEqual({
      [MCP_EXT_SKILLS]: { directoryRead: true },
      [MCP_EXT_UI]: { mimeTypes: ["text/html;profile=mcp-app"] },
    });
    expect(() => negotiateExtensions({ "example/invented": {} }, {})).toThrow(
      "unsupported extension",
    );
    expect(() =>
      negotiateExtensions({ [MCP_EXT_TASKS]: { invented: true } }, {}),
    ).toThrow("unsupported settings");
  });
  test("skill manifests retain frontmatter and require a valid complete digest list", () => {
    const uri = "skill://test/SKILL.md";
    const skill = {
      uri,
      frontmatter: { name: "test", description: "Test", custom: "retained" },
      resources: [{ uri, digest: `sha256:${"a".repeat(64)}`, size: 12 }],
    };
    expect(validateSkill(skill)).toBe(skill);
    expect(() => validateSkill({ ...skill, resources: [] })).toThrow("omits");
    expect(() =>
      validateSkill({
        ...skill,
        resources: [{ uri, digest: "sha256:bad", size: 12 }],
      }),
    ).toThrow("digest");
  });
});
describe("bounded JSON Schema validation", () => {
  test("2020-12 keywords, boolean schemas, local refs, and draft-07 are validated", () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "array",
      prefixItems: [{ type: "integer" }],
      items: false,
      "x-custom": { retained: true },
    };
    expect(validateSchema(schema)).toBe(schema);
    expect(() => validateInstance(schema, [1])).not.toThrow();
    expect(() => validateInstance(schema, ["bad"])).toThrow(McpError);
    expect(() => validateInstance(false, null)).toThrow(McpError);
    expect(() =>
      validateInstance(
        { $defs: { n: { type: "number" } }, $ref: "#/$defs/n" },
        1,
      ),
    ).not.toThrow();
    expect(() =>
      validateInstance(
        { $schema: "http://json-schema.org/draft-07/schema#", type: "number" },
        "no",
      ),
    ).toThrow(McpError);
  });
  test("schema validity is separate, no network refs, unknown dialects fail", () => {
    expect(() => validateSchema({ type: "nonsense" })).toThrow(McpError);
    expect(() =>
      validateSchema({ $schema: "https://example.test/schema" }),
    ).toThrow("dialect");
    expect(() =>
      validateSchema({ $ref: "https://example.test/private" }),
    ).toThrow(McpError);
    const schema = { type: "integer" };
    validateSchema(schema);
    schema.type = "string";
    expect(() => validateInstance(schema, 1)).toThrow(McpError);
  });
  test("depth and data limits run before compilation/validation", () => {
    let schema: unknown = true;
    for (let i = 0; i < 70; i++) schema = { properties: { nested: schema } };
    expect(() => validateSchema(schema)).toThrow("complexity");
    expect(() =>
      validateInstance(true, "x".repeat(4 * 1024 * 1024 + 1)),
    ).toThrow("byte limit");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => validateSchema(cyclic)).toThrow("cyclic");
  });
});

test("empty generic schemas remain valid but tool input schemas require object shape", () => {
  const schema = {};
  expect(validateSchema(schema)).toBe(schema);
  for (const value of [null, 42, "text", [], {}])
    expect(() => validateInstance(schema, value)).not.toThrow();
  expect(() =>
    validateResult("tools/list", { tools: [{ name: "t", inputSchema: {} }] }),
  ).toThrow("inputSchema must have type object");
  expect(() =>
    validateResult("tools/list", {
      tools: [{ name: "t", inputSchema: { type: "object" } }],
    }),
  ).not.toThrow();
});

test("modern content is normative with or without an explicit complete resultType", () => {
  for (const tag of [{}, { resultType: "complete" }]) {
    const result = { ...tag, content: [{ type: "text", text: "ok" }] };
    expect(validateResult("tools/call", result)).toBe(result);
    for (const content of [
      "ok",
      [{ type: "text", text: 1 }],
      [{ type: "invented" }],
    ])
      expect(() => validateResult("tools/call", { ...tag, content })).toThrow(
        McpError,
      );
  }
});

test("only an absent result discriminator defaults to complete; null is invalid", () => {
  for (const value of [
    { content: [] },
    { resultType: "complete", content: [] },
  ])
    expect(validateResult("tools/call", value)).toBe(value);
  for (const resultType of [null, "unknown", false, 0])
    expect(() =>
      validateResult("tools/call", { resultType, content: [] }),
    ).toThrow("unrecognized resultType");
});
