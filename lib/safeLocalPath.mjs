/**
 * lib/safeLocalPath.mjs
 *
 * A redirect target taken from a request must be a path on this site.
 * "//evil.com" and "/\evil.com" both start with "/" but browsers treat them as
 * another host, and a line break would split the Location header.
 */
export function isSafeLocalPath(value) {
  return typeof value === "string" && /^\/(?![\/\\])/.test(value) && !/[\r\n]/.test(value);
}
