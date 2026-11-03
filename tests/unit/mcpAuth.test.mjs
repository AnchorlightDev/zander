import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readBearer, checkAccessToken } from "../../lib/mcp/auth.mjs";
import { isMcpResource, mcpResourceUrl } from "../../lib/mcp/config.mjs";

const SITE = "https://zander.example.com";
let saved;

beforeEach(() => {
  saved = { siteAddress: process.env.siteAddress, id: process.env.OIDC_MCP_CLIENT_ID };
  process.env.siteAddress = `${SITE}/`;
  delete process.env.OIDC_MCP_CLIENT_ID;
});

afterEach(() => {
  process.env.siteAddress = saved.siteAddress;
  if (saved.id === undefined) delete process.env.OIDC_MCP_CLIENT_ID;
  else process.env.OIDC_MCP_CLIENT_ID = saved.id;
});

const good = () => ({
  isExpired: false,
  clientId: "claude",
  aud: `${SITE}/mcp`,
  scope: "zander:mcp",
  accountId: "42",
});

describe("readBearer", () => {
  it("extracts the token", () => {
    expect(readBearer("Bearer abc.DEF-123_~")).toBe("abc.DEF-123_~");
    expect(readBearer("bearer abc")).toBe("abc");
  });

  it("rejects anything else", () => {
    expect(readBearer(undefined)).toBeNull();
    expect(readBearer("Basic abc")).toBeNull();
    expect(readBearer("Bearer ")).toBeNull();
    expect(readBearer("Bearer a b")).toBeNull();
  });
});

describe("mcp resource", () => {
  it("is the site's /mcp URL, trailing slash tolerated", () => {
    expect(mcpResourceUrl()).toBe(`${SITE}/mcp`);
    expect(isMcpResource(`${SITE}/mcp/`)).toBe(true);
    expect(isMcpResource(`${SITE}/api`)).toBe(false);
    expect(isMcpResource(undefined)).toBe(false);
  });
});

describe("checkAccessToken", () => {
  it("accepts an MCP token and returns the user", () => {
    expect(checkAccessToken(good())).toEqual({ ok: true, userId: 42 });
  });

  it("refuses tokens that are missing, expired, or meant for something else", () => {
    expect(checkAccessToken(null).ok).toBe(false);
    expect(checkAccessToken({ ...good(), isExpired: true }).ok).toBe(false);
    expect(checkAccessToken({ ...good(), clientId: "compass" }).ok).toBe(false);
    expect(checkAccessToken({ ...good(), aud: `${SITE}/oidc/me` }).ok).toBe(false);
    expect(checkAccessToken({ ...good(), aud: undefined }).ok).toBe(false);
    expect(checkAccessToken({ ...good(), scope: "openid" }).ok).toBe(false);
    expect(checkAccessToken({ ...good(), accountId: "abc" }).ok).toBe(false);
  });

  it("follows a configured client id", () => {
    process.env.OIDC_MCP_CLIENT_ID = "zander-claude";
    expect(checkAccessToken(good()).ok).toBe(false);
    expect(checkAccessToken({ ...good(), clientId: "zander-claude" }).ok).toBe(true);
  });
});
