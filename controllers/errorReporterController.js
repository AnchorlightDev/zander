import os from "os";
import crypto from "crypto";
import dotenv from "dotenv";
import { sendRawMail } from "./emailController.js";

dotenv.config();

/**
 * Global error reporter: funnels uncaught exceptions, unhandled rejections,
 * Fastify 5xx errors and every console.error / console.warn call into a
 * throttled email to the system admin.
 *
 * Config (all via .env):
 *   adminErrorEmail          recipient address. If unset, reporting is disabled.
 *   errorEmailLevels         comma list of console levels to capture. Default "error,warn".
 *   errorEmailCooldownMinutes  per-unique-error resend cooldown. Default 15.
 *   errorEmailHourlyCap      max emails sent per rolling hour. Default 30.
 */

const RECIPIENT = (process.env.adminErrorEmail || "").trim();
const LEVELS = (process.env.errorEmailLevels || "error,warn")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const COOLDOWN_MS =
  Math.max(1, Number(process.env.errorEmailCooldownMinutes) || 15) * 60 * 1000;
const HOURLY_CAP = Math.max(1, Number(process.env.errorEmailHourlyCap) || 30);

// Substrings (case-insensitive) that, if found anywhere in the message, mean
// "don't email this". Node runtime warnings and known-noisy framework notices
// are ignored by default; extend via errorEmailIgnore (comma-separated).
const DEFAULT_IGNORE = [
  "DeprecationWarning",
  "ExperimentalWarning",
  "[FSTDEP",
  "--trace-deprecation",
  "--trace-warnings",
  "punycode",
];
const IGNORE = [
  ...DEFAULT_IGNORE,
  ...(process.env.errorEmailIgnore || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
].map((s) => s.toLowerCase());

function isIgnored(text) {
  const haystack = String(text).toLowerCase();
  return IGNORE.some((needle) => haystack.includes(needle));
}

const HOSTNAME = os.hostname();
const APP_ENV = process.env.NODE_ENV || "unknown";

// Capture pristine console methods before any patching so the reporter can log
// its own diagnostics without recursing into itself.
const rawConsole = {
  error: console.error.bind(console),
  warn: console.warn.bind(console),
  info: console.info.bind(console),
};

// hash -> { count, firstSeen, lastSentAt }
const seen = new Map();

let windowStartedAt = Date.now();
let sentThisWindow = 0;
let suppressedThisWindow = 0;

// Re-entrancy guard: while an email is being built/sent, any console.error the
// mail path itself emits must not be re-reported (that would loop forever).
let reporting = false;

function isEnabled() {
  return Boolean(RECIPIENT && process.env.smtpHost);
}

function rollWindowIfNeeded() {
  if (Date.now() - windowStartedAt < 60 * 60 * 1000) return;
  const droppedByCap = suppressedThisWindow;
  windowStartedAt = Date.now();
  sentThisWindow = 0;
  suppressedThisWindow = 0;
  if (droppedByCap > 0) {
    // Announce the gap so silence is never mistaken for calm.
    void deliver(
      `[zander ${APP_ENV}] ${droppedByCap} further error(s) suppressed by hourly cap`,
      `<p>${droppedByCap} error/warning event(s) in the last hour were not emailed ` +
        `because the hourly cap of ${HOURLY_CAP} was reached. Check the server logs on ` +
        `<code>${escapeHtml(HOSTNAME)}</code> for the full picture.</p>`,
      `${droppedByCap} error(s) suppressed by hourly cap on ${HOSTNAME}. See server logs.`
    );
  }
}

function fingerprint(level, message, stack) {
  const basis = stack
    ? stack.split("\n").slice(0, 4).join("\n")
    : String(message).slice(0, 400);
  return crypto.createHash("sha1").update(`${level}\n${basis}`).digest("hex");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function stringifyArg(arg) {
  if (arg instanceof Error) {
    return arg.stack || `${arg.name}: ${arg.message}`;
  }
  if (typeof arg === "string") return arg;
  try {
    return JSON.stringify(arg, null, 2);
  } catch {
    return String(arg);
  }
}

async function deliver(subject, bodyHtml, bodyText) {
  const html =
    `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.5">` +
    `<p style="margin:0 0 12px"><strong>Host:</strong> ${escapeHtml(HOSTNAME)} ` +
    `&nbsp;<strong>Env:</strong> ${escapeHtml(APP_ENV)} ` +
    `&nbsp;<strong>Time:</strong> ${new Date().toISOString()}</p>` +
    bodyHtml +
    `</div>`;
  await sendRawMail(RECIPIENT, subject, html, { text: bodyText });
}

/**
 * Report one error/warning. Never throws, never blocks meaningfully
 * (email send is fire-and-forget from the caller's perspective).
 */
export function reportError({ level = "error", source = "app", message, error, meta } = {}) {
  try {
    if (!isEnabled() || reporting) return;

    const normalizedLevel = String(level).toLowerCase();
    if (!LEVELS.includes(normalizedLevel)) return;

    const err = error instanceof Error ? error : undefined;
    const text =
      message != null
        ? typeof message === "string"
          ? message
          : stringifyArg(message)
        : err
          ? `${err.name}: ${err.message}`
          : "(no message)";
    const stack = err?.stack;

    if (isIgnored(stack ? `${text}\n${stack}` : text)) return;

    rollWindowIfNeeded();

    const hash = fingerprint(normalizedLevel, text, stack);
    const now = Date.now();
    const record = seen.get(hash);

    if (record) {
      record.count += 1;
      if (now - record.lastSentAt < COOLDOWN_MS) return; // still cooling down
    }

    if (sentThisWindow >= HOURLY_CAP) {
      suppressedThisWindow += 1;
      return;
    }

    const occurrence = record ? record.count + 1 : 1;
    seen.set(hash, { count: occurrence, firstSeen: record?.firstSeen ?? now, lastSentAt: now });
    sentThisWindow += 1;

    const firstLine = text.split("\n")[0].slice(0, 120);
    const subject = `[zander ${APP_ENV}] ${normalizedLevel.toUpperCase()}: ${firstLine}`;

    const metaBlock =
      meta != null
        ? `<p style="margin:16px 0 4px"><strong>Context</strong></p>` +
          `<pre style="background:#f4f4f5;padding:12px;border-radius:6px;white-space:pre-wrap;word-break:break-word">${escapeHtml(
            stringifyArg(meta)
          )}</pre>`
        : "";

    const stackBlock = stack
      ? `<p style="margin:16px 0 4px"><strong>Stack</strong></p>` +
        `<pre style="background:#f4f4f5;padding:12px;border-radius:6px;white-space:pre-wrap;word-break:break-word">${escapeHtml(
          stack
        )}</pre>`
      : "";

    const bodyHtml =
      `<p style="margin:0 0 4px"><strong>Source:</strong> ${escapeHtml(source)} ` +
      `&nbsp;<strong>Occurrence:</strong> #${occurrence}` +
      (occurrence > 1
        ? ` (repeats folded; next report no sooner than ${Math.round(
            COOLDOWN_MS / 60000
          )} min)`
        : "") +
      `</p>` +
      `<pre style="background:#fff4f4;padding:12px;border-radius:6px;white-space:pre-wrap;word-break:break-word">${escapeHtml(
        text
      )}</pre>` +
      stackBlock +
      metaBlock;

    const bodyText =
      `Source: ${source} | Occurrence #${occurrence}\n\n${text}` +
      (stack ? `\n\n${stack}` : "") +
      (meta != null ? `\n\nContext:\n${stringifyArg(meta)}` : "");

    reporting = true;
    deliver(subject, bodyHtml, bodyText)
      .catch((mailErr) => {
        rawConsole.error(
          "[errorReporter] failed to send alert email:",
          mailErr?.message || mailErr
        );
      })
      .finally(() => {
        reporting = false;
      });
  } catch (selfErr) {
    reporting = false;
    try {
      rawConsole.error("[errorReporter] internal failure:", selfErr?.message || selfErr);
    } catch {
      /* give up quietly */
    }
  }
}

/**
 * Patch console.error / console.warn (per configured levels) and register
 * process-level handlers. Safe to call once at startup.
 */
let installed = false;
export function installGlobalErrorReporting() {
  if (installed) return;
  installed = true;

  if (!isEnabled()) {
    rawConsole.info(
      "[errorReporter] disabled (set adminErrorEmail and smtpHost in .env to enable)"
    );
    return;
  }

  for (const level of ["error", "warn"]) {
    if (!LEVELS.includes(level)) continue;
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      if (reporting) return; // don't report the mailer's own noise
      const errArg = args.find((a) => a instanceof Error);
      const message = args.map(stringifyArg).join(" ");
      reportError({ level, source: `console.${level}`, message, error: errArg });
    };
  }

  process.on("unhandledRejection", (reason) => {
    reportError({
      level: "error",
      source: "unhandledRejection",
      message: reason instanceof Error ? undefined : stringifyArg(reason),
      error: reason instanceof Error ? reason : undefined,
    });
  });

  process.on("uncaughtException", (err) => {
    reportError({ level: "error", source: "uncaughtException", error: err });
  });

  rawConsole.info(
    `[errorReporter] active -> ${RECIPIENT} (levels: ${LEVELS.join(
      ", "
    )}, cooldown ${COOLDOWN_MS / 60000}m, cap ${HOURLY_CAP}/h)`
  );
}
