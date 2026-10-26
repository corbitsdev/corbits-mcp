import { describe, expect, test } from "bun:test";
import { McpError, McpErrorCode } from "./errors.js";
import {
  collectHeaderSlots,
  decodeHeaderValue,
  encodeHeaderValue,
} from "./headers.js";

describe("MCP header value codec", () => {
  test.each([
    "",
    "plain ASCII ~!",
    "internal space\tallowed",
    "=?base64?literal",
    "=?base64?",
    "=?base64?YQ==",
    "literal?=",
    "x=?base64?YQ==?=",
    "=?BASE64?YQ==?=",
    "=?base64?YQ==?=suffix",
  ])("preserves plain or incomplete sentinel value %j", (value) => {
    expect(encodeHeaderValue(value)).toBe(value);
    expect(decodeHeaderValue(value)).toBe(value);
    expect(decodeHeaderValue(encodeHeaderValue(value))).toBe(value);
  });

  test.each([
    "=?base64?literal?=",
    "=?base64?YQ==?=",
    "=?base64??=",
    "=?base64?%%%?=",
    "Hello, 世界",
    "café",
    "\u{1D11E}",
    " leading",
    "trailing ",
    "\tleading",
    "trailing\t",
    "line1\r\nInjected: yes",
    "nul\0value",
    "delete\x7f",
  ])("encodes unsafe or complete sentinel value %j exactly once", (value) => {
    const encoded = encodeHeaderValue(value);
    expect(encoded).toBe(`=?base64?${Buffer.from(value).toString("base64")}?=`);
    expect(decodeHeaderValue(encoded)).toBe(value);
    expect(new Headers({ "Mcp-Name": encoded }).get("Mcp-Name")).toBe(encoded);
    expect(encoded).not.toMatch(/[\r\n\0]/);
  });

  test("decodes normative UTF-8 and empty payload examples", () => {
    expect(decodeHeaderValue("=?base64?SGVsbG8sIOS4lueVjA==?=")).toBe(
      "Hello, 世界",
    );
    expect(decodeHeaderValue("=?base64??=")).toBe("");
  });

  test.each([
    "%%%",
    "YQ",
    "YQ=",
    "YQ===",
    "YR==",
    "A",
    "Y Q==",
    "YQ==\r\nInjected: yes",
    "_w==",
    "/w==",
    "wK8=",
    "7aCA",
    "4oI=",
  ])("rejects malformed base64 or UTF-8 payload %j", (payload) => {
    expect(() => decodeHeaderValue(`=?base64?${payload}?=`)).toThrow(McpError);
    try {
      decodeHeaderValue(`=?base64?${payload}?=`);
    } catch (error) {
      expect(error).toMatchObject({
        status: 400,
        code: McpErrorCode.HeaderMismatch,
      });
    }
  });

  test("encodes every ASCII control except internal horizontal tab", () => {
    for (let code = 0; code <= 0x7f; code++) {
      const value = `a${String.fromCharCode(code)}z`;
      const encoded = encodeHeaderValue(value);
      expect(decodeHeaderValue(encoded)).toBe(value);
      if ((code < 0x20 && code !== 0x09) || code === 0x7f) {
        expect(encoded.startsWith("=?base64?")).toBe(true);
      } else {
        expect(encoded).toBe(value);
      }
    }
  });

  test.each(["Region\r\nInjected", "Region: injected", "", "Region\0"])(
    "rejects unsafe header annotation %j",
    (header) => {
      expect(() =>
        collectHeaderSlots({
          properties: { region: { type: "string", "x-mcp-header": header } },
        }),
      ).toThrow(McpError);
    },
  );
});
