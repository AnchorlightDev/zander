import sanitizeHtml from "sanitize-html";

/**
 * Shared HTML sanitization for user-submitted rich text (forum posts, profile
 * "About Me", etc.) produced by the Summernote WYSIWYG editor
 * (see views/partials/summerNoteEditor.ejs for the toolbar this allowlist is
 * calibrated against).
 *
 * Strips <script>/<object>/<embed>, all event-handler attributes (onerror,
 * onclick, ...), and javascript:/data: URLs in href/src, while keeping the
 * common formatting output Summernote's toolbar produces.
 */

const ALLOWED_TAGS = [
  "p", "br", "span", "div",
  "strong", "b", "em", "i", "u", "s", "strike",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li",
  "a", "img",
  "blockquote", "code", "pre",
  "table", "thead", "tbody", "tr", "td", "th",
  "iframe",
];

const ALLOWED_ATTRIBUTES = {
  a: ["href", "target", "rel", "title"],
  img: ["src", "alt", "title", "width", "height", "style"],
  span: ["style"],
  div: ["style"],
  p: ["style"],
  td: ["colspan", "rowspan", "style"],
  th: ["colspan", "rowspan", "style"],
  iframe: ["src", "width", "height", "frameborder", "allowfullscreen"],
};

const sanitizeOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: ALLOWED_ATTRIBUTES,
  // `class` on every tag let authors apply any Bootstrap utility (fixed
  // full-screen overlays, `stretched-link`, `modal`) inside a post. Only the
  // classes Summernote itself emits and harmless text helpers are kept.
  allowedClasses: {
    "*": [/^note-/, /^text-(start|end|center|muted|break)$/, /^fw-(bold|semibold|normal|light)$/, /^fst-italic$/, /^table(-[a-z-]+)?$/],
  },
  // "//evil.example" is a different host dressed up as a relative URL.
  allowProtocolRelative: false,
  // Deeply nested markup is cheap to send and expensive to parse.
  nestingLimit: 50,
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: {
    img: ["http", "https"],
  },
  allowedIframeHostnames: [
    "www.youtube.com",
    "youtube.com",
    "player.vimeo.com",
  ],
  allowedStyles: {
    "*": {
      color: [/^#[0-9a-fA-F]{3,8}$/, /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*[\d.]+\s*)?\)$/],
      "background-color": [/^#[0-9a-fA-F]{3,8}$/, /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*[\d.]+\s*)?\)$/],
      "text-align": [/^left$|^right$|^center$|^justify$/],
    },
  },
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer nofollow", target: "_blank" }),
    // Summernote inserts video embeds with a protocol-relative src
    // (`//www.youtube.com/embed/...`). `allowProtocolRelative: false` would
    // otherwise strip that src and leave a blank iframe, so upgrade it to
    // https here. The allowedIframeHostnames check below still restricts which
    // hosts may be framed, so this does not widen what can be embedded.
    iframe(tagName, attribs) {
      if (attribs.src && attribs.src.startsWith("//")) {
        attribs.src = `https:${attribs.src}`;
      }
      return { tagName, attribs };
    },
  },
  disallowedTagsMode: "discard",
};

// Tags whose text must never be turned into links.
const NO_LINKIFY_TAGS = new Set(["a", "code", "pre", "script", "style", "iframe", "textarea"]);
const URL_IN_TEXT = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
// Entities that end a URL when they appear in already-escaped text.
const URL_STOP_ENTITY = /&(?:nbsp|lt|gt|quot|#39|#x27|#160);/i;
const TRAILING_PUNCT = /[.,;:!?)\]}'"]+$/;

function linkifyText(text) {
  return text.replace(URL_IN_TEXT, (match) => {
    let url = match;
    let rest = "";
    const stop = url.search(URL_STOP_ENTITY);
    if (stop !== -1) {
      rest = url.slice(stop);
      url = url.slice(0, stop);
    }
    const punct = url.match(TRAILING_PUNCT);
    if (punct) {
      rest = punct[0] + rest;
      url = url.slice(0, -punct[0].length);
    }
    if (!url || /^www\.$/i.test(url)) return match;
    const href = /^www\./i.test(url) ? `https://${url}` : url;
    return `<a href="${href.replace(/"/g, "&quot;")}" target="_blank" rel="noopener noreferrer nofollow">${url}</a>${rest}`;
  });
}

/**
 * Turn bare http(s):// and www. URLs in rich-text HTML into links. Text already
 * inside <a>, <code> or <pre> is left alone, so it is safe to run more than once.
 * Expects sanitized (entity-escaped) HTML; only adds http(s) anchors.
 * @param {string} html
 * @returns {string}
 */
export function linkifyHtml(html) {
  if (!html || typeof html !== "string") return html || "";
  const parts = html.split(/(<[^>]*>)/);
  const stack = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    if (part.startsWith("<")) {
      const m = part.match(/^<\s*(\/)?\s*([a-zA-Z0-9]+)/);
      if (!m) continue;
      const tag = m[2].toLowerCase();
      if (!NO_LINKIFY_TAGS.has(tag)) continue;
      if (m[1]) {
        const idx = stack.lastIndexOf(tag);
        if (idx !== -1) stack.splice(idx);
      } else if (!/\/\s*>$/.test(part)) {
        stack.push(tag);
      }
      continue;
    }
    if (stack.length === 0) parts[i] = linkifyText(part);
  }
  return parts.join("");
}

/**
 * Sanitize HTML produced by the forum/rich-text editors before persisting it.
 * @param {string} html
 * @returns {string}
 */
export function sanitizeForumHtml(html) {
  if (!html || typeof html !== "string") return "";
  // Sanitize first so linkify only ever sees escaped text, then sanitize the
  // result again so added anchors get the same rel/target treatment.
  return sanitizeHtml(linkifyHtml(sanitizeHtml(html, sanitizeOptions)), sanitizeOptions);
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/**
 * Plain-text preview of rich-text HTML, cut at a word boundary to at most
 * `maxLength` characters. Returns raw text -- escape it when rendering.
 * @param {string} html
 * @param {number} [maxLength]
 * @returns {string}
 */
export function plainTextExcerpt(html, maxLength = 160) {
  if (!html || typeof html !== "string") return "";
  // Keep words in neighbouring blocks apart once the tags are gone
  const spaced = html.replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>|<br\s*\/?>/gi, " ");
  const text = sanitizeHtml(spaced, { allowedTags: [], allowedAttributes: {} })
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === "#") {
        const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim();

  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s.,;:!?-]+$/, "") + "…";
}

export default sanitizeForumHtml;
