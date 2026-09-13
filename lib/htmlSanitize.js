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
  iframe: ["src", "width", "height", "frameborder", "allow", "allowfullscreen"],
  "*": ["class"],
};

const sanitizeOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: ALLOWED_ATTRIBUTES,
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
      color: [/^#[0-9a-fA-F]{3,6}$/, /^rgb\(.*\)$/],
      "background-color": [/^#[0-9a-fA-F]{3,6}$/, /^rgb\(.*\)$/],
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

export default sanitizeForumHtml;
