import { expect, test } from "bun:test";
import { validateResult } from "./schemas.js";
import { assertJsonBounds, validateSchema } from "./json-schema.js";

const maxDecodedBytes = 16 * 1024 * 1024;
const context = { maxDecodedBytes };
const resource = (text: string) => ({
  contents: [{ uri: "test://large", text }],
});

test("explicit resource validation admits payloads but does not raise default or other method limits", () => {
  const text = "x".repeat(4 * 1024 * 1024);
  expect(
    validateResult("resources/read", resource(text), context),
  ).toHaveProperty("contents");
  expect(() => validateResult("resources/read", resource(text))).toThrow(
    "JSON byte limit",
  );
  expect(() => assertJsonBounds(resource(text))).toThrow("JSON byte limit");
  for (const method of [
    "tools/call",
    "prompts/get",
    "resources/list",
    "server/discover",
  ])
    expect(() =>
      validateResult(method, { ...resource(text), extra: text }, context),
    ).toThrow("JSON byte limit");
});

test("resource validation independently clamps budgets and counts aggregate decoded text/blob", () => {
  for (const value of [-1, Infinity, NaN, 0.5])
    expect(() =>
      validateResult("resources/read", resource(""), {
        maxDecodedBytes: value,
      }),
    ).toThrow("safe integer");
  expect(() =>
    validateResult(
      "resources/read",
      resource("x".repeat(maxDecodedBytes + 1)),
      { maxDecodedBytes: Number.MAX_SAFE_INTEGER },
    ),
  ).toThrow("decoded byte limit");
  expect(() =>
    validateResult(
      "resources/read",
      {
        contents: [
          { uri: "a", text: "é" },
          { uri: "b", blob: "YWI=" },
        ],
      },
      { maxDecodedBytes: 3 },
    ),
  ).toThrow("decoded byte limit");
});

test("resource allowance retains metadata, schema, node, depth and JSON validity bounds", () => {
  for (const extra of [
    { _meta: { text: "x".repeat(64 * 1024) } },
    { extra: { contents: [{ text: "x".repeat(64 * 1024) }] } },
    { _meta: { escaped: "\u0000".repeat(12 * 1024) } },
  ])
    expect(() =>
      validateResult("resources/read", { ...resource(""), ...extra }, context),
    ).toThrow("metadata/envelope");
  let deep: unknown = null;
  for (let i = 0; i < 65; i++) deep = [deep];
  expect(() =>
    validateResult("resources/read", { ...resource(""), deep }, context),
  ).toThrow("complexity");
  expect(() =>
    validateResult(
      "resources/read",
      { ...resource(""), nodes: Array(100_001).fill(null) },
      context,
    ),
  ).toThrow();
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const extra of [cycle, { value: Infinity }, { value: () => 0 }])
    expect(() =>
      validateResult("resources/read", { ...resource(""), extra }, context),
    ).toThrow();
  expect(() => validateSchema({ description: "x".repeat(256 * 1024) })).toThrow(
    "JSON byte limit",
  );
  expect(() =>
    validateResult(
      "resources/read",
      { contents: [{ uri: "a", text: "x", blob: "eA==" }] },
      context,
    ),
  ).toThrow("invalid resource contents");
});
