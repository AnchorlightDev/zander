import { describe, it, expect, vi } from "vitest";

// resolveCommandTemplate produces the string that zander-addon hands to
// Bukkit.dispatchCommand(getConsoleSender(), ...) — i.e. it runs with full
// operator rights on a game server. Callers validate their inputs today
// (gift recipients are checked against /^[A-Za-z0-9_]{1,16}$/ at checkout),
// so these tests pin the function's own guarantees rather than a live bug.

vi.mock("../../controllers/databaseController.js", () => ({
  default: { query: vi.fn() },
  prisma: {},
}));

const { resolveCommandTemplate, sanitiseCommandValue } = await import(
  "../../controllers/webstoreController.js"
);

describe("resolveCommandTemplate", () => {
  it("substitutes a placeholder", () => {
    expect(resolveCommandTemplate("lp user {{username}} parent add vip", { username: "Steve" }))
      .toBe("lp user Steve parent add vip");
  });

  it("is whitespace and case tolerant in the placeholder", () => {
    expect(resolveCommandTemplate("say {{  USERNAME  }}", { username: "Steve" })).toBe("say Steve");
  });

  it("returns the template untouched when there is no metadata", () => {
    expect(resolveCommandTemplate("say hello", null)).toBe("say hello");
  });

  it("handles a non-string template", () => {
    expect(resolveCommandTemplate(null, { a: 1 })).toBe("");
  });

  it("treats $ sequences in a value literally", () => {
    // String.prototype.replace expands "$&" in a replacement string, so a
    // naive implementation would echo the matched placeholder back into the
    // command instead of inserting the value.
    const out = resolveCommandTemplate("say {{username}}", { username: "$&" });
    expect(out).not.toContain("{{username}}");
  });

  it("cannot introduce an extra argument via whitespace", () => {
    // The attack this guards: a value with a space turns one argument into
    // two, retargeting the command.
    const out = resolveCommandTemplate("lp user {{username}} parent add vip", {
      username: "evil parent add admin",
    });
    expect(out).toBe("lp user evilparentaddadmin parent add vip");
    expect(out.split(" ")).toHaveLength(6);
  });

  it("survives a placeholder name containing regex syntax", () => {
    // An unescaped key would make the RegExp constructor throw.
    expect(() => resolveCommandTemplate("say {{a(b}}", { "a(b": "x" })).not.toThrow();
  });

  it("does not backtrack pathologically on a hostile key", () => {
    const started = Date.now();
    expect(() =>
      resolveCommandTemplate("say {{x}}", { "(a+)+$": "y", x: "ok" })
    ).not.toThrow();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("leaves unknown placeholders in place rather than emptying the command", () => {
    expect(resolveCommandTemplate("say {{missing}}", { username: "Steve" }))
      .toBe("say {{missing}}");
  });

  it("renders null and undefined values as empty", () => {
    expect(resolveCommandTemplate("say {{a}}{{b}}", { a: null, b: undefined })).toBe("say ");
  });
});

describe("sanitiseCommandValue", () => {
  it("keeps every character a Minecraft username can contain", () => {
    expect(sanitiseCommandValue("Steve_123")).toBe("Steve_123");
  });

  it("keeps the punctuation legitimate identifiers use", () => {
    // Floodgate Bedrock names carry a '.' prefix; price ids and emails appear
    // in metadata too.
    expect(sanitiseCommandValue(".BedrockUser")).toBe(".BedrockUser");
    expect(sanitiseCommandValue("price_1A2b3C")).toBe("price_1A2b3C");
  });

  it("strips whitespace and command-shaping characters", () => {
    expect(sanitiseCommandValue("a b")).toBe("ab");
    expect(sanitiseCommandValue("a\nb")).toBe("ab");
    expect(sanitiseCommandValue('a"b')).toBe("ab");
  });

  it("coerces non-strings", () => {
    expect(sanitiseCommandValue(42)).toBe("42");
  });
});
