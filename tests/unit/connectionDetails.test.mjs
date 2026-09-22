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
    const { bedrock } = getConnectionDetails(config({ bedrock: { host: "bedrock.example.net", port: 19132 } }));

    expect(bedrock).toEqual({
      host: "bedrock.example.net",
      port: 19132,
      configured: true,
      address: "bedrock.example.net:19132",
    });
  });

  it("writes a Java address without a port when none is set", () => {
    // Java is conventionally given as a bare host; the client assumes 25565.
    const { java } = getConnectionDetails(config({ java: { host: "play.example.net", port: null } }));

    expect(java.address).toBe("play.example.net");
    expect(java.port).toBeNull();
    expect(java.configured).toBe(true);
  });

  it("includes the port when Java runs on a non-default one", () => {
    const { java } = getConnectionDetails(config({ java: { host: "play.example.net", port: 25566 } }));
    expect(java.address).toBe("play.example.net:25566");
  });

  it("lower-cases and trims the host", () => {
    const { java } = getConnectionDetails(config({ java: { host: "  Play.Example.NET  " } }));
    expect(java.host).toBe("play.example.net");
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
    const port = (value) => getConnectionDetails(config({ bedrock: { host: "b.example.net", port: value } })).bedrock.port;

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
      const { bedrock } = getConnectionDetails(config({ bedrock: { host: "b.example.net", port: 99999 } }));
      expect(bedrock.address).toBe("b.example.net");
    });
  });
});

describe("hasBedrockConnection", () => {
  it("is true only when a Bedrock host is configured", () => {
    expect(hasBedrockConnection(config({ bedrock: { host: "b.example.net", port: 19132 } }))).toBe(true);
    expect(hasBedrockConnection(config({ bedrock: { host: "", port: 19132 } }))).toBe(false);
    expect(hasBedrockConnection(config({ java: { host: "play.example.net" } }))).toBe(false);
    expect(hasBedrockConnection({})).toBe(false);
  });
});
