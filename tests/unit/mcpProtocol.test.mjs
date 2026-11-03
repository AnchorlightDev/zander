import { describe, it, expect, vi } from "vitest";
import {
  createMcpHandler,
  validateArguments,
  toToolResult,
  ToolError,
  LATEST_PROTOCOL_VERSION,
  ERROR,
} from "../../lib/mcp/protocol.mjs";

const echo = {
  name: "echo",
  description: "Echo",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", maxLength: 10 },
      count: { type: "integer", minimum: 1, maximum: 3 },
      mode: { type: "string", enum: ["a", "b"] },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["text"],
  },
  handler: async (args) => ({ said: args.text }),
};

const refuse = {
  name: "refuse",
  description: "Always refuses",
  inputSchema: { type: "object", properties: {} },
  handler: async () => {
    throw new ToolError("Not allowed.");
  },
};

const crash = {
  name: "crash",
  description: "Throws",
  inputSchema: { type: "object", properties: {} },
  handler: async () => {
    throw new Error("db exploded: secret detail");
  },
};

function makeHandler(onToolError = () => {}) {
  return createMcpHandler({
    serverInfo: { name: "zander", version: "1.0.0" },
    instructions: "Be careful.",
    listTools: () => [echo, refuse, crash],
    onToolError,
  });
}

describe("validateArguments", () => {
  it("accepts valid arguments", () => {
    expect(validateArguments(echo.inputSchema, { text: "hi", count: 2, mode: "a", tags: ["x"] })).toBeNull();
  });

  it("reports the first problem", () => {
    expect(validateArguments(echo.inputSchema, {})).toMatch(/text/);
    expect(validateArguments(echo.inputSchema, { text: 5 })).toMatch(/string/);
    expect(validateArguments(echo.inputSchema, { text: "x", count: 1.5 })).toMatch(/whole number/);
    expect(validateArguments(echo.inputSchema, { text: "x", count: 9 })).toMatch(/at most 3/);
    expect(validateArguments(echo.inputSchema, { text: "x", mode: "c" })).toMatch(/one of/);
    expect(validateArguments(echo.inputSchema, { text: "x", tags: [1] })).toMatch(/tags/);
    expect(validateArguments(echo.inputSchema, { text: "x".repeat(11) })).toMatch(/10 characters/);
    expect(validateArguments(echo.inputSchema, [])).toMatch(/object/);
  });
});

describe("createMcpHandler", () => {
  it("negotiates the protocol version", async () => {
    const handle = makeHandler();
    const known = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
    expect(known.result.protocolVersion).toBe("2025-03-26");
    expect(known.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(known.result.instructions).toBe("Be careful.");

    const unknown = await handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    expect(unknown.result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  });

  it("returns nothing for notifications", async () => {
    expect(await makeHandler()({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });

  it("lists tools without their handlers", async () => {
    const res = await makeHandler()({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    expect(res.result.tools.map((t) => t.name)).toEqual(["echo", "refuse", "crash"]);
    expect(res.result.tools[0].handler).toBeUndefined();
    expect(res.result.tools[0].inputSchema.required).toEqual(["text"]);
  });

  it("calls a tool and wraps the result as text", async () => {
    const res = await makeHandler()({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "echo", arguments: { text: "hello" } },
    });
    expect(res.id).toBe(4);
    expect(res.result.isError).toBeUndefined();
    expect(JSON.parse(res.result.content[0].text)).toEqual({ said: "hello" });
  });

  it("reports bad arguments and ToolErrors as tool errors the model can read", async () => {
    const handle = makeHandler();
    const bad = await handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "echo", arguments: {} } });
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).toMatch(/text/);

    const refused = await handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "refuse" } });
    expect(refused.result).toEqual({ content: [{ type: "text", text: "Not allowed." }], isError: true });
  });

  it("hides unexpected error details from the model", async () => {
    const onToolError = vi.fn();
    const res = await makeHandler(onToolError)({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "crash" } });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).not.toMatch(/secret/);
    expect(onToolError).toHaveBeenCalledOnce();
  });

  it("rejects unknown tools, methods and malformed messages", async () => {
    const handle = makeHandler();
    const unknownTool = await handle({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "nope" } });
    expect(unknownTool.error.code).toBe(ERROR.INVALID_PARAMS);

    const unknownMethod = await handle({ jsonrpc: "2.0", id: 9, method: "resources/list" });
    expect(unknownMethod.error.code).toBe(ERROR.METHOD_NOT_FOUND);

    const malformed = await handle({ id: 10, method: "ping" });
    expect(malformed.error.code).toBe(ERROR.INVALID_REQUEST);

    expect((await handle({ jsonrpc: "2.0", id: 11, method: "ping" })).result).toEqual({});
  });
});

describe("toToolResult", () => {
  it("truncates very large output", () => {
    const text = toToolResult("x".repeat(70_000)).content[0].text;
    expect(text.length).toBeLessThan(61_000);
    expect(text).toMatch(/truncated/);
  });
});
