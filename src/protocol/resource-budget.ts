import { McpError } from "./errors.js";

/** An incremental allocation guard, not a replacement JSON validator. Only strings
 * at result.contents[*].text/blob count. The normal parser validates the envelope
 * and content afterwards. Keys/escapes can cross arbitrary transport chunks. */
function resourceCounter(
  maxBytes: number,
  payloadByte: (char: string) => void,
) {
  const stack: {
    path: string[];
    array: boolean;
    key: string;
    keyNext: boolean;
  }[] = [];
  let inString = false;
  let isKey = false;
  let key = "";
  let escape = false;
  let hex: string | undefined;
  let kind: "text" | "blob" | undefined;
  let bytes = 0;
  let highSurrogate = false;
  let base64Characters = 0;
  const valuePath = (): string[] => {
    const parent = stack.at(-1);
    return parent === undefined
      ? []
      : [...parent.path, parent.array ? "*" : parent.key];
  };
  function character(char: string) {
    if (isKey) {
      // Only short protocol keys matter; don't accumulate attacker-sized keys.
      if (key.length < 32) key += char;
      return;
    }
    if (kind === "text") {
      const code = char.charCodeAt(0);
      if (code >= 0xdc00 && code <= 0xdfff && highSurrogate) bytes += 1;
      else bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
      highSurrogate = code >= 0xd800 && code <= 0xdbff;
    } else if (kind === "blob" && char !== "=") {
      // Every non-padding base64 character contributes six bits. Counting before
      // atob/Buffer allocation handles all three padding cases exactly.
      const previous = Math.floor((base64Characters * 6) / 8);
      base64Characters++;
      bytes += Math.floor((base64Characters * 6) / 8) - previous;
    }
    if (bytes > maxBytes)
      throw new McpError("Resource decoded byte limit exceeded");
  }
  return (text: string) => {
    // Iterate UTF-16 units so raw and escaped surrogate pairs count identically.
    for (let i = 0; i < text.length; i++) {
      const char = text[i]!;
      if (inString) {
        if (
          !isKey &&
          kind !== undefined &&
          (char !== '"' || escape || hex !== undefined)
        )
          payloadByte(char);
        if (hex !== undefined) {
          hex += char;
          if (hex.length === 4) {
            character(String.fromCharCode(Number.parseInt(hex, 16)));
            hex = undefined;
          }
        } else if (escape) {
          escape = false;
          if (char === "u") hex = "";
          else
            character(
              (
                { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" } as Record<
                  string,
                  string
                >
              )[char] ?? char,
            );
        } else if (char === "\\") escape = true;
        else if (char === '"') {
          inString = false;
          if (isKey) {
            const parent = stack.at(-1);
            if (parent !== undefined) parent.key = key;
          }
        } else character(char);
        continue;
      }
      const parent = stack.at(-1);
      if (char === '"') {
        inString = true;
        isKey = parent !== undefined && !parent.array && parent.keyNext;
        key = "";
        highSurrogate = false;
        base64Characters = 0;
        const path = valuePath();
        kind =
          !isKey &&
          path.length === 4 &&
          path[0] === "result" &&
          path[1] === "contents" &&
          path[2] === "*"
            ? path[3] === "text"
              ? "text"
              : path[3] === "blob"
                ? "blob"
                : undefined
            : undefined;
      } else if (char === "{" || char === "[") {
        if (stack.length >= 64)
          throw new McpError("Resource JSON depth limit exceeded");
        stack.push({
          path: valuePath(),
          array: char === "[",
          key: "",
          keyNext: true,
        });
      } else if (char === "}" || char === "]") stack.pop();
      else if (char === ":" && parent !== undefined) parent.keyNext = false;
      else if (char === "," && parent !== undefined) parent.keyNext = true;
    }
  };
}

export interface ResourceBudget {
  push(chunk: Uint8Array): void;
  finish(): void;
}

/** Explicit resource reads support at most 16 MiB decoded. JSON-escaped base64
 * needs up to eight wire bytes per decoded byte (plus padding); text needs six.
 * URI/metadata/RPC/SSE overhead has a separate 64 KiB cap, not unused payload
 * allowance. Unbounded requests retain the transport's default 4 MiB cap. */
export function createResourceBudget(
  maxBytes: number,
  sse: boolean,
): ResourceBudget {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new McpError("maxDecodedBytes must be a nonnegative safe integer");
  maxBytes = Math.min(maxBytes, 16 * 1024 * 1024);
  const maxEnvelopeBytes = 64 * 1024;
  const maxWireBytes = Math.ceil(maxBytes / 3) * 24 + maxEnvelopeBytes;
  let decodedWireBytes = 0;
  let payloadWireBytes = 0;
  function payloadByte(char: string) {
    const code = char.charCodeAt(0);
    payloadWireBytes +=
      code < 0x80
        ? 1
        : code < 0x800
          ? 2
          : code >= 0xd800 && code <= 0xdbff
            ? 0
            : code >= 0xdc00 && code <= 0xdfff
              ? 4
              : 3;
  }
  let wireBytes = 0;
  const decoder = new TextDecoder();
  let count = resourceCounter(maxBytes, payloadByte);
  let prefix = "";
  let data = false;
  let lineStarted = false;
  let previousCR = false;
  function feed(text: string) {
    if (!sse) {
      count(text);
      return;
    }
    for (let i = 0; i < text.length; i++) {
      const char = text[i]!;
      if (char === "\n" && previousCR) {
        previousCR = false;
        continue;
      }
      previousCR = char === "\r";
      if (char === "\r" || char === "\n") {
        if (!lineStarted) count = resourceCounter(maxBytes, payloadByte);
        else if (data) count("\n");
        prefix = "";
        data = false;
        lineStarted = false;
      } else {
        lineStarted = true;
        if (data) count(char);
        else if (prefix.length < 5) {
          prefix += char;
          if (prefix === "data:") data = true;
        }
      }
    }
  }
  function accept(text: string) {
    decodedWireBytes += Buffer.byteLength(text, "utf8");
    feed(text);
    if (decodedWireBytes - payloadWireBytes > maxEnvelopeBytes)
      throw new McpError("Resource metadata/envelope byte limit exceeded");
  }
  return {
    push(chunk) {
      wireBytes += chunk.byteLength;
      if (wireBytes > maxWireBytes)
        throw new McpError("Resource wire byte budget exceeded");
      accept(decoder.decode(chunk, { stream: true }));
    },
    finish() {
      accept(decoder.decode());
    },
  };
}
