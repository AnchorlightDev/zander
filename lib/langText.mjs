/**
 * lib/langText.mjs
 *
 * Reading page copy out of lang.json.
 *
 * lang.json has always held operational messages -- API errors, banner text --
 * read directly as `lang.api.noToken` from route handlers. Page copy is a
 * different job: it is nested, some of it is lists, and it needs the site's own
 * name dropped into it, which is exactly the thing that must not be hard-coded
 * into a template.
 *
 * Imports nothing, so it is unit-testable without a lang file or a renderer.
 *
 * Tokens use the %UPPERCASE% style lang.json already uses for %USERNAME% and
 * %UUID%, so there is one convention rather than two.
 */

/** Replace %TOKEN% with vars.TOKEN. An unknown token is left alone. */
export function fillTokens(text, vars = {}) {
  return String(text ?? "").replace(/%([A-Z0-9_]+)%/g, (match, key) => {
    const value = vars[key];
    return value === undefined || value === null ? match : String(value);
  });
}

/** Walk a dotted path. Returns undefined rather than throwing on a gap. */
export function resolveLangPath(lang, path) {
  const parts = String(path ?? "").split(".").filter(Boolean);
  let node = lang;
  for (const part of parts) {
    if (node === null || typeof node !== "object") return undefined;
    node = node[part];
  }
  return node;
}

/**
 * A reader bound to one lang file and a set of default tokens.
 *
 * Passed into a view so templates can say `t("bedrock.heading")` instead of
 * carrying English of their own. A missing key yields an empty string rather
 * than "undefined" on the page -- and `has()` lets a template drop a whole
 * section it has no copy for, which is how the operator-specific parts stay
 * out of the way until somebody fills them in.
 */
export function createTranslator(lang, defaultVars = {}) {
  const read = (path) => resolveLangPath(lang, path);

  const t = (path, vars) =>
    fillTokens(typeof read(path) === "string" ? read(path) : "", { ...defaultVars, ...vars });

  /** A list of strings, each token-filled. Non-arrays and gaps give []. */
  t.list = (path, vars) => {
    const value = read(path);
    if (!Array.isArray(value)) return [];
    return value
      .filter((entry) => typeof entry === "string")
      .map((entry) => fillTokens(entry, { ...defaultVars, ...vars }));
  };

  /** True when there is non-empty copy at this path. */
  t.has = (path) => {
    const value = read(path);
    if (typeof value === "string") return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    return false;
  };

  return t;
}
