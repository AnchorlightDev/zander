import { describe, expect, it } from "vitest";
import {
  ACCOUNT_STATE,
  classifyAccountState,
  derivePlatform,
  isPasswordResetEligible,
  maskEmail,
} from "../../controllers/userAccountState.js";

describe("classifyAccountState", () => {
  it("classifies a fully registered account", () => {
    const user = {
      email: "player@example.com",
      password_hash: "hash",
      account_registered: new Date(),
    };
    expect(classifyAccountState(user)).toBe(ACCOUNT_STATE.REGISTERED);
  });

  it("classifies a Minecraft-only profile (no email/password/registration)", () => {
    const user = { email: null, password_hash: null, account_registered: null };
    expect(classifyAccountState(user)).toBe(ACCOUNT_STATE.MINECRAFT_PROFILE_ONLY);
  });

  it("classifies a Minecraft-only profile even when Discord is forcelinked without local credentials", () => {
    const user = { email: null, password_hash: null, account_registered: null, discordId: "12345" };
    expect(classifyAccountState(user)).toBe(ACCOUNT_STATE.MINECRAFT_PROFILE_ONLY);
  });

  it("classifies email+password set but registration not completed as incomplete", () => {
    const user = { email: "player@example.com", password_hash: "hash", account_registered: null };
    expect(classifyAccountState(user)).toBe(ACCOUNT_STATE.REGISTRATION_INCOMPLETE);
  });

  it("classifies password set but no email as incomplete", () => {
    const user = { email: null, password_hash: "hash", account_registered: null };
    expect(classifyAccountState(user)).toBe(ACCOUNT_STATE.REGISTRATION_INCOMPLETE);
  });

  it("classifies account_registered set but no password as incomplete", () => {
    const user = { email: "player@example.com", password_hash: null, account_registered: new Date() };
    expect(classifyAccountState(user)).toBe(ACCOUNT_STATE.REGISTRATION_INCOMPLETE);
  });

  it("handles missing/undefined fields gracefully", () => {
    expect(classifyAccountState({})).toBe(ACCOUNT_STATE.MINECRAFT_PROFILE_ONLY);
  });
});

describe("derivePlatform", () => {
  it("detects Bedrock via the Floodgate '.' prefix", () => {
    expect(derivePlatform(".Pizzaraptor8")).toBe("BEDROCK");
  });

  it("detects Java for a plain username", () => {
    expect(derivePlatform("Cerealraptor300")).toBe("JAVA");
  });
});

describe("isPasswordResetEligible", () => {
  it("is eligible with email + password and not disabled", () => {
    expect(isPasswordResetEligible({ email: "a@b.com", password_hash: "hash", account_disabled: false })).toBe(true);
  });

  it("is ineligible with no email", () => {
    expect(isPasswordResetEligible({ email: null, password_hash: "hash", account_disabled: false })).toBe(false);
  });

  it("is ineligible with no password", () => {
    expect(isPasswordResetEligible({ email: "a@b.com", password_hash: null, account_disabled: false })).toBe(false);
  });

  it("is ineligible when the account is disabled", () => {
    expect(isPasswordResetEligible({ email: "a@b.com", password_hash: "hash", account_disabled: true })).toBe(false);
  });
});

describe("maskEmail", () => {
  it("masks a typical email address", () => {
    expect(maskEmail("cerealraptor@gmail.com")).toBe("ce***@gmail.com");
  });

  it("masks a short local-part email address", () => {
    expect(maskEmail("p@outlook.com")).toBe("p***@outlook.com");
  });

  it("returns null for missing/invalid email", () => {
    expect(maskEmail(null)).toBeNull();
    expect(maskEmail(undefined)).toBeNull();
    expect(maskEmail("not-an-email")).toBeNull();
  });
});
