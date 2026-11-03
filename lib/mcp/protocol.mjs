/**
 * lib/mcp/protocol.mjs
 *
 * A minimal, stateless Model Context Protocol server over Streamable HTTP:
 * every POST carries one JSON-RPC message and gets one JSON response (no SSE
 * stream, no server-initiated messages), which is all a tools-only server
 * needs. Kept free of Fastify and the database so it is unit-tested directly.
 *
 * Spec: https://modelcontextprotocol.io/specification/2025-06-18
 */

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export const ERROR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
};

/** A tool's own failure, reported to the model as an isError result. */
export class ToolError extends Error {}

/**
 * Check `args` against the small JSON Schema subset the tools use (object with
 * typed properties, required, enum, arrays of scalars). Returns an error
 * message, or null when the arguments are acceptable.
 */
export function validateArguments(schema, args) {
  if (args === undefined || args === null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) return "Arguments must be an object.";

  const properties = schema?.properties || {};
  for (const name of schema?.required || []) {
    if (args[name] === undefined || args[name] === null || args[name] === "") {
      return `Missing required argument "${name}".`;
    }
  }

  for (const [name, value] of Object.entries(args)) {
    const prop = properties[name];
    if (!prop) {
      if (schema?.additionalProperties === false) return `Unknown argument "${name}".`;
      continue;
    }
    if (value === undefined || value === null) continue;
    const problem = checkType(prop, value, name);
    if (problem) return problem;
  }
  return null;
}

function checkType(prop, value, name) {
  const type = prop.type;
  if (type === "string" && typeof value !== "string") return `"${name}" must be a string.`;
  if (type === "boolean" && typeof value !== "boolean") return `"${name}" must be true or false.`;
  if (type === "integer" && !Number.isInteger(value)) return `"${name}" must be a whole number.`;
  if (type === "number" && (typeof value !== "number" || !Number.isFinite(value))) return `"${name}" must be a number.`;
  if (type === "array") {
    if (!Array.isArray(value)) return `"${name}" must be a list.`;
    if (prop.items) {
      for (const item of value) {
        const problem = checkType(prop.items, item, `${name}[]`);
        if (problem) return problem;
      }
    }
  }
  if (prop.enum && !prop.enum.includes(value)) {
    return `"${name}" must be one of: ${prop.enum.join(", ")}.`;
  }
  if (type === "integer" || type === "number") {
    if (prop.minimum !== undefined && value < prop.minimum) return `"${name}" must be at least ${prop.minimum}.`;
    if (prop.maximum !== undefined && value > prop.maximum) return `"${name}" must be at most ${prop.maximum}.`;
  }
  if (type === "string" && prop.maxLength !== undefined && value.length > prop.maxLength) {
    return `"${name}" must be at most ${prop.maxLength} characters.`;
  }
  return null;
}

const MAX_TEXT = 60_000;

/** Render a tool's return value as MCP content. */
export function toToolResult(value, isError = false) {
  let text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (text === undefined) text = "Done.";
  if (text.length > MAX_TEXT) {
    text = `${text.slice(0, MAX_TEXT)}\n… (truncated; narrow the request to see more)`;
  }
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/**
 * Create a handler for one JSON-RPC message.
 *
 * @param {object} opts
 * @param {{ name: string, version: string, title?: string }} opts.serverInfo
 * @param {string} [opts.instructions]
 * @param {(ctx) => Array<object>} opts.listTools      tools visible to this caller
 * @param {(ctx) => (string) => object|undefined} [opts.findTool]
 * @returns {(message: any, ctx: any) => Promise<object|null>} null for notifications
 */
export function createMcpHandler({ serverInfo, instructions, listTools, onToolError }) {
  return async function handle(message, ctx) {
    if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") {
      return rpcError(message?.id, ERROR.INVALID_REQUEST, "Expected a single JSON-RPC 2.0 message.");
    }

    const { id, method, params } = message;
    const isNotification = id === undefined;
    if (typeof method !== "string") {
      return isNotification ? null : rpcError(id, ERROR.INVALID_REQUEST, "Missing method.");
    }

    // Notifications (initialized, cancelled, ...) need no reply.
    if (isNotification) return null;

    switch (method) {
      case "initialize": {
        const requested = params?.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : LATEST_PROTOCOL_VERSION;
        return rpcResult(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo,
          ...(instructions ? { instructions } : {}),
        });
      }

      case "ping":
        return rpcResult(id, {});

      case "tools/list": {
        const tools = listTools(ctx).map(({ name, title, description, inputSchema, annotations }) => ({
          name,
          ...(title ? { title } : {}),
          description,
          inputSchema,
          ...(annotations ? { annotations } : {}),
        }));
        return rpcResult(id, { tools });
      }

      case "tools/call": {
        const name = params?.name;
        const tool = listTools(ctx).find((t) => t.name === name);
        if (!tool) return rpcError(id, ERROR.INVALID_PARAMS, `Unknown tool: ${name}`);

        const args = params?.arguments ?? {};
        const problem = validateArguments(tool.inputSchema, args);
        if (problem) return rpcResult(id, toToolResult(problem, true));

        try {
          const value = await tool.handler(args, ctx);
          return rpcResult(id, toToolResult(value));
        } catch (error) {
          if (error instanceof ToolError) return rpcResult(id, toToolResult(error.message, true));
          onToolError?.(name, error);
          return rpcResult(id, toToolResult(`Zander hit an error running ${name}. Check the server logs.`, true));
        }
      }

      default:
        return rpcError(id, ERROR.METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  };
}
