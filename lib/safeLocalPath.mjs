/**
 * lib/safeLocalPath.mjs
 *
 * A redirect target taken from a request must be a path on this site.
 * "//evil.com" and "/\evil.com" both start with "/" but browsers treat them as
 * another host, and a line break would split the Location header.
 *
 * Browsers also delete tabs and line breaks from a URL before resolving it, so
 * "/<TAB>/evil.com" arrives as "//evil.com". Every control character is
 * therefore rejected, not only CR/LF.
 */

// Any origin that cannot exist; only used to resolve a value as a path.
const LOCAL_ORIGIN = "http://zander.invalid";

export function isSafeLocalPath(value) {
  return (
    typeof value === "string" &&
    /^\/(?![\/\\])/.test(value) &&
    !/[\u0000-\u001f\u007f\\]/.test(value)
  );
}

/**
 * The value as a same-site path ("/a/b?c#d"), or `fallback` when it is not
 * one. Resolving it against a fixed origin and rebuilding it from the parts
 * means what is redirected to is never the raw request value.
 */
export function toSafeLocalPath(value, fallback = null) {
  if (!isSafeLocalPath(value)) return fallback;
  let url;
  try {
    url = new URL(value, LOCAL_ORIGIN);
  } catch {
    return fallback;
  }
  if (url.origin !== LOCAL_ORIGIN) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}
