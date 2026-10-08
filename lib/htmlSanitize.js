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
  },
  disallowedTagsMode: "discard",
};

/**
 * Sanitize HTML produced by the forum/rich-text editors before persisting it.
 * @param {string} html
 * @returns {string}
 */
export function sanitizeForumHtml(html) {
  if (!html || typeof html !== "string") return "";
  return sanitizeHtml(html, sanitizeOptions);
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
