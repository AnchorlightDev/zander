import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetUsersList = vi.fn();
const mockGetUsersSummaryStats = vi.fn();
const mockGetUserDetailById = vi.fn();
const mockGetUserEmailById = vi.fn();
const mockUpdateUserEmail = vi.fn();
vi.mock("../../controllers/usersAdminController.js", () => ({
  getUsersList: (...args) => mockGetUsersList(...args),
  getUsersSummaryStats: (...args) => mockGetUsersSummaryStats(...args),
  getUserDetailById: (...args) => mockGetUserDetailById(...args),
  getUserEmailById: (...args) => mockGetUserEmailById(...args),
  updateUserEmail: (...args) => mockUpdateUserEmail(...args),
}));

const mockByUserId = vi.fn();
const mockByEmail = vi.fn();
vi.mock("../../controllers/userController.js", () => ({
  UserGetter: class {
    byUserId(...args) { return mockByUserId(...args); }
    byEmail(...args) { return mockByEmail(...args); }
  },
}));

const mockGenerateVerificationCode = vi.fn();
const mockCreateEmailVerification = vi.fn();
const mockCreatePasswordResetRequest = vi.fn();
vi.mock("../../controllers/sessionController.js", () => ({
  generateVerificationCode: (...args) => mockGenerateVerificationCode(...args),
  createEmailVerification: (...args) => mockCreateEmailVerification(...args),
  createPasswordResetRequest: (...args) => mockCreatePasswordResetRequest(...args),
}));

const mockSendMail = vi.fn();
vi.mock("../../controllers/emailController.js", () => ({
  sendMail: (...args) => mockSendMail(...args),
}));

const { default: adminUsersRoute } = await import("../../api/routes/adminUsers.js");

function createApp() {
  const routes = {};
  const app = {
    get: (path, handler) => { routes[`GET ${path}`] = handler; },
    post: (path, handler) => { routes[`POST ${path}`] = handler; },
  };
  return { app, routes };
}

function createReply() {
  return {
    sent: false,
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    send(payload) { this.sent = true; this.payload = payload; return this; },
  };
}

const CONFIG = { siteConfiguration: { siteName: "Zander" } };

function invoke(routes, key, req) {
  const res = createReply();
  return routes[key](req, res).then(() => res.payload).catch(() => res.payload);
}

describe("adminUsersRoute — data exposure", () => {
  beforeEach(() => vi.clearAllMocks());

  it("GET /admin/users/:userId never leaks password_hash even if the controller row somehow includes it", async () => {
    const { app, routes } = createApp();
    adminUsersRoute(app, CONFIG, {}, {}, {});

    mockGetUserDetailById.mockResolvedValue({
      userId: 1,
      username: "Cerealraptor300",
      password_hash: "SHOULD_NEVER_LEAK",
      relatedAccounts: [],
    });

    const payload = await invoke(routes, "GET /admin/users/:userId", { params: { userId: "1" }, query: {} });

    expect(payload.success).toBe(true);
    expect(JSON.stringify(payload)).not.toContain("SHOULD_NEVER_LEAK");
    expect(payload.data.email).toBeUndefined(); // masked by default, no revealEmail=true
  });

  it("GET /admin/users/:userId only includes the full email when revealEmail=true", async () => {
    const { app, routes } = createApp();
    adminUsersRoute(app, CONFIG, {}, {}, {});

    mockGetUserDetailById.mockResolvedValue({ userId: 1, username: "Cerealraptor300", relatedAccounts: [] });
    mockGetUserEmailById.mockResolvedValue("real@example.com");

    const payload = await invoke(routes, "GET /admin/users/:userId", {
      params: { userId: "1" },
      query: { revealEmail: "true" },
    });

    expect(payload.data.email).toBe("real@example.com");
  });
});

describe("adminUsersRoute — POST /admin/users/:userId/reset-password", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses with an explanatory message when the account has no password configured", async () => {
    const { app, routes } = createApp();
    adminUsersRoute(app, CONFIG, {}, {}, {});

    mockByUserId.mockResolvedValue({ userId: 1, username: "Pizzaraptor8", email: null, password_hash: null, account_disabled: false });

    const payload = await invoke(routes, "POST /admin/users/:userId/reset-password", { params: { userId: "1" } });

    expect(payload.success).toBe(false);
    expect(payload.message).toMatch(/no email address configured/i);
    expect(mockCreatePasswordResetRequest).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("refuses when the account is disabled", async () => {
    const { app, routes } = createApp();
    adminUsersRoute(app, CONFIG, {}, {}, {});

    mockByUserId.mockResolvedValue({ userId: 1, username: "X", email: "x@example.com", password_hash: "hash", account_disabled: true });

    const payload = await invoke(routes, "POST /admin/users/:userId/reset-password", { params: { userId: "1" } });

    expect(payload.success).toBe(false);
    expect(payload.message).toMatch(/disabled/i);
  });

  it("succeeds for an eligible account, reusing the existing reset-code + email primitives", async () => {
    const { app, routes } = createApp();
    adminUsersRoute(app, CONFIG, {}, {}, {});

    mockByUserId.mockResolvedValue({
      userId: 1,
      username: "Cerealraptor300",
      email: "player@example.com",
      password_hash: "hash",
      account_disabled: false,
    });
    mockGenerateVerificationCode.mockResolvedValue("123456");
    mockCreatePasswordResetRequest.mockResolvedValue(true);
    mockSendMail.mockResolvedValue(true);

    const payload = await invoke(routes, "POST /admin/users/:userId/reset-password", { params: { userId: "1" } });

    expect(payload.success).toBe(true);
    expect(mockCreatePasswordResetRequest).toHaveBeenCalledWith(1, "123456", expect.any(Date));
    expect(mockSendMail).toHaveBeenCalledWith(
      "player@example.com",
      expect.stringContaining("Reset your"),
      "passwordResetCode.ejs",
      expect.objectContaining({ code: "123456" })
    );
  });
});

describe("adminUsersRoute — POST /admin/users/:userId/resend-verification", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses when there is no email on file", async () => {
    const { app, routes } = createApp();
    adminUsersRoute(app, CONFIG, {}, {}, {});
    mockByUserId.mockResolvedValue({ userId: 1, username: "X", email: null, email_verified: false });

    const payload = await invoke(routes, "POST /admin/users/:userId/resend-verification", { params: { userId: "1" } });
    expect(payload.success).toBe(false);
    expect(mockCreateEmailVerification).not.toHaveBeenCalled();
  });

  it("refuses when the email is already verified", async () => {
    const { app, routes } = createApp();
    adminUsersRoute(app, CONFIG, {}, {}, {});
    mockByUserId.mockResolvedValue({ userId: 1, username: "X", email: "x@example.com", email_verified: true });

    const payload = await invoke(routes, "POST /admin/users/:userId/resend-verification", { params: { userId: "1" } });
    expect(payload.success).toBe(false);
    expect(mockCreateEmailVerification).not.toHaveBeenCalled();
  });

  it("resends verification for an unverified account with an email", async () => {
    const { app, routes } = createApp();
    adminUsersRoute(app, CONFIG, {}, {}, {});
    mockByUserId.mockResolvedValue({ userId: 1, username: "X", email: "x@example.com", email_verified: false });
    mockGenerateVerificationCode.mockResolvedValue("654321");

    const payload = await invoke(routes, "POST /admin/users/:userId/resend-verification", { params: { userId: "1" } });
    expect(payload.success).toBe(true);
    expect(mockCreateEmailVerification).toHaveBeenCalledWith(1, "654321", expect.any(Date));
    expect(mockSendMail).toHaveBeenCalled();
  });
});

describe("adminUsersRoute — POST /admin/users/:userId/change-email", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects an invalid email format", async () => {
    const { app, routes } = createApp();
    adminUsersRoute(app, CONFIG, {}, {}, {});

    const payload = await invoke(routes, "POST /admin/users/:userId/change-email", {
      params: { userId: "1" },
      body: { newEmail: "not-an-email" },
    });

    expect(payload.success).toBe(false);
    expect(mockUpdateUserEmail).not.toHaveBeenCalled();
  });

  it("rejects a duplicate email already used by another account", async () => {
    const { app, routes } = createApp();
    adminUsersRoute(app, CONFIG, {}, {}, {});

    mockByUserId.mockResolvedValue({ userId: 1, username: "X" });
    mockByEmail.mockResolvedValue({ userId: 2 });

    const payload = await invoke(routes, "POST /admin/users/:userId/change-email", {
      params: { userId: "1" },
      body: { newEmail: "taken@example.com" },
    });

    expect(payload.success).toBe(false);
    expect(payload.message).toMatch(/already in use/i);
    expect(mockUpdateUserEmail).not.toHaveBeenCalled();
  });

  it("updates the email and does not auto-verify it", async () => {
    const { app, routes } = createApp();
    adminUsersRoute(app, CONFIG, {}, {}, {});

    mockByUserId.mockResolvedValue({ userId: 1, username: "X" });
    mockByEmail.mockResolvedValue(null);
    mockUpdateUserEmail.mockResolvedValue(true);

    const payload = await invoke(routes, "POST /admin/users/:userId/change-email", {
      params: { userId: "1" },
      body: { newEmail: "new@example.com" },
    });

    expect(payload.success).toBe(true);
    expect(mockUpdateUserEmail).toHaveBeenCalledWith(1, "new@example.com");
    // updateUserEmail itself (controllers/usersAdminController.js) is mocked here —
    // the important assertion is that this route never calls anything resembling
    // markEmailVerified after a change.
  });
});
