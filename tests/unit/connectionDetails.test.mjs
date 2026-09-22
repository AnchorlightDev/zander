/**
 * tests/unit/connectionDetails.test.mjs
 *
 * Reading connection details out of config. Pure, so no config file or server
 * is involved.
 */

import { describe, expect, it } from "vitest";
import { getConnectionDetails, hasBedrockConnection } from "../../lib/connectionDetails.mjs";

const config = (connection) => ({ connection });

describe("getConnectionDetails", () => {
  it("returns host, port and a joined address for Bedrock", () => {
    const { bedrock } = getConnectionDetails(config({ bedrock: { host: "bedrock.zanderdemo.net", port: 19132 } }));

    expect(bedrock).toEqual({
      host: "bedrock.zanderdemo.net",
      port: 19132,
      configured: true,
      address: "bedrock.zanderdemo.net:19132",
    });
  });

  it("writes a Java address without a port when none is set", () => {
    // Java is conventionally given as a bare host; the client assumes 25565.
    const { java } = getConnectionDetails(config({ java: { host: "play.zanderdemo.net", port: null } }));

    expect(java.address).toBe("play.zanderdemo.net");
    expect(java.port).toBeNull();
    expect(java.configured).toBe(true);
  });

  it("includes the port when Java runs on a non-default one", () => {
    const { java } = getConnectionDetails(config({ java: { host: "play.zanderdemo.net", port: 25566 } }));
    expect(java.address).toBe("play.zanderdemo.net:25566");
  });

  it("lower-cases and trims the host", () => {
    const { java } = getConnectionDetails(config({ java: { host: "  Play.ZanderDemo.NET  " } }));
    expect(java.host).toBe("play.zanderdemo.net");
  });

  it("always returns both editions, so a template never tests for the block", () => {
    const details = getConnectionDetails({});

    expect(details.java.configured).toBe(false);
    expect(details.bedrock.configured).toBe(false);
    expect(details.bedrock.address).toBeNull();
  });

  it("survives a missing or junk config", () => {
    expect(getConnectionDetails(undefined).java.configured).toBe(false);
    expect(getConnectionDetails(null).bedrock.configured).toBe(false);
    expect(getConnectionDetails(config({ bedrock: "nonsense" })).bedrock.configured).toBe(false);
  });

  describe("port validation", () => {
    const port = (value) => getConnectionDetails(config({ bedrock: { host: "b.zanderdemo.net", port: value } })).bedrock.port;

    it("accepts a real port", () => {
      expect(port(19132)).toBe(19132);
      expect(port("19132")).toBe(19132);
      expect(port(1)).toBe(1);
      expect(port(65535)).toBe(65535);
    });

    it("treats anything out of range as no port at all", () => {
      expect(port(0)).toBeNull();
      expect(port(-1)).toBeNull();
      expect(port(65536)).toBeNull();
      expect(port(19132.5)).toBeNull();
      expect(port("not a port")).toBeNull();
      expect(port(null)).toBeNull();
    });

    it("renders the bare host when the port is unusable", () => {
      const { bedrock } = getConnectionDetails(config({ bedrock: { host: "b.zanderdemo.net", port: 99999 } }));
      expect(bedrock.address).toBe("b.zanderdemo.net");
    });
  });
});

describe("placeholder hosts count as unconfigured", () => {
  // Without this, a half-configured install publishes its own example config
  // as a real server address, on an indexed page, with structured data
  // asserting it. The only symptom is players failing to connect to a host
  // that does not exist.
  const host = (h) => getConnectionDetails(config({ bedrock: { host: h, port: 19132 } })).bedrock;

  it("rejects the RFC 2606 reserved domains", () => {
    for (const h of ["example.com", "example.net", "example.org",
                     "bedrock.example.net", "play.example.com"]) {
      expect(host(h).configured, h).toBe(false);
      expect(host(h).address, h).toBeNull();
    }
  });

  it("rejects the reserved TLDs", () => {
    for (const h of ["srv.test", "srv.example", "srv.invalid", "srv.localhost"]) {
      expect(host(h).configured, h).toBe(false);
    }
  });

  it("rejects the placeholders this repo ships", () => {
    expect(host("changeme").configured).toBe(false);
    expect(host("your-server.com").configured).toBe(false);
    expect(host("yourdomain.net").configured).toBe(false);
  });

  it("leaves real hosts alone, including ones containing the word example", () => {
    expect(host("play.hypixel.net").configured).toBe(true);
    expect(host("mc.somecommunity.org").configured).toBe(true);
    // "exampleserver.net" is a real domain, not a reserved one.
    expect(host("exampleserver.net").configured).toBe(true);
  });

  it("makes the page render its not-configured state rather than a fake address", () => {
    expect(hasBedrockConnection(config({ bedrock: { host: "bedrock.example.net" } }))).toBe(false);
  });
});

describe("hasBedrockConnection", () => {
  it("is true only when a Bedrock host is configured", () => {
    expect(hasBedrockConnection(config({ bedrock: { host: "b.zanderdemo.net", port: 19132 } }))).toBe(true);
    expect(hasBedrockConnection(config({ bedrock: { host: "", port: 19132 } }))).toBe(false);
    expect(hasBedrockConnection(config({ java: { host: "play.zanderdemo.net" } }))).toBe(false);
    expect(hasBedrockConnection({})).toBe(false);
  });
});
