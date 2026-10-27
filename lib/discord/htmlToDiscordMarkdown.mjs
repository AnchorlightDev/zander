/**
 * lib/discord/htmlToDiscordMarkdown.mjs
 *
 * Convert the rich-text HTML produced by the dashboard embed editor (Summernote)
 * into Discord-flavoured Markdown. Discord embed descriptions render Markdown,
 * not HTML, so without this the raw tags (<h1>, <span style>, <strong>, <p>,
 * <ul>, <a href>) show up literally in the posted embed.
 *
 * Deliberately dependency-free and forgiving: it maps the handful of tags the
 * editor emits and strips everything else (spans, inline styles, classes). Not a
 * general HTML parser — just enough for staff-authored embed copy.
 */

const ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

function decodeEntities(s) {
  return s
    .replace(/&amp;|&lt;|&gt;|&quot;|&#39;|&apos;|&nbsp;/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_m, code) => {
      const n = Number(code);
      return Number.isFinite(n) ? String.fromCodePoint(n) : _m;
    });
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, "");
}

/** Discord embed descriptions cap at 4096 characters. */
const MAX_DESCRIPTION = 4096;

/**
 * @param {string} html
 * @returns {string} Discord-flavoured Markdown
 */
export function htmlToDiscordMarkdown(html) {
  if (!html || typeof html !== "string") return "";

  let s = html.replace(/\r\n?/g, "\n");

  // Links first so URLs survive later tag stripping: <a href="URL">text</a> -> [text](URL)
  s = s.replace(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href, text) => {
      const label = stripTags(text).trim() || href;
      return `[${label}](${href})`;
    }
  );

  // Inline emphasis.
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner) => `**${inner.trim()}**`);
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner) => `*${inner.trim()}*`);
  s = s.replace(/<u\b[^>]*>([\s\S]*?)<\/u>/gi, (_m, inner) => `__${inner.trim()}__`);
  s = s.replace(/<(s|strike|del)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner) => `~~${inner.trim()}~~`);
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner) => `\`${stripTags(inner).trim()}\``);

  // Headings -> Discord headings (# / ## / ###, which Discord supports).
  s = s.replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, (_m, inner) => `\n# ${inner.trim()}\n`);
  s = s.replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, (_m, inner) => `\n## ${inner.trim()}\n`);
  s = s.replace(/<h[3-6]\b[^>]*>([\s\S]*?)<\/h[3-6]>/gi, (_m, inner) => `\n### ${inner.trim()}\n`);

  // Lists.
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner) => `\n- ${inner.trim()}`);
  s = s.replace(/<\/?(ul|ol)\b[^>]*>/gi, "\n");

  // Block breaks.
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|h[1-6])>/gi, "\n\n");
  s = s.replace(/<(p|div)\b[^>]*>/gi, "");

  // Anything left (spans, styled wrappers, stray tags) goes.
  s = stripTags(s);
  s = decodeEntities(s);

  // Tidy whitespace: trim each line, collapse 3+ blank lines to one.
  s = s
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return s.length > MAX_DESCRIPTION ? s.slice(0, MAX_DESCRIPTION - 1).trimEnd() + "…" : s;
}
