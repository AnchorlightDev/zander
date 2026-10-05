/**
 * lib/region.mjs
 *
 * Where the community is, as a fact the site can state and search engines can
 * read.
 *
 * Imports nothing, so it is unit-testable without a config file.
 *
 * Exists because the region was previously not stated anywhere a visitor could
 * see, while `og:locale` was hard-coded to one particular country and
 * `<html lang>` disagreed with it. Both are derived here from one configured
 * value, so they cannot drift apart and no server's country is baked into a
 * template.
 */

/** ISO 3166-1 alpha-2, e.g. AU. */
const COUNTRY = /^[A-Za-z]{2}$/;

/** ISO 639-1, e.g. en. */
const LANGUAGE = /^[A-Za-z]{2}$/;

/**
 * Normalised region details, always the same shape.
 *
 *   name         what the copy says, e.g. "Australia"
 *   countryCode  uppercase alpha-2, or null
 *   language     lowercase alpha-2, defaulting to "en"
 *   htmlLang     for <html lang>, e.g. "en-AU"
 *   locale       for og:locale, e.g. "en_AU"
 *   configured   whether there is enough to state a region at all
 *
 * `htmlLang` and `locale` are derived rather than configured separately: they
 * are the same fact in two spellings, and letting an operator set them
 * independently is just an invitation for them to disagree.
 */
export function getRegion(config) {
  const raw = config?.siteConfiguration?.region ?? {};

  const name = String(raw.name ?? "").trim() || null;

  const countryCode = COUNTRY.test(String(raw.countryCode ?? "").trim())
    ? String(raw.countryCode).trim().toUpperCase()
    : null;

  const language = LANGUAGE.test(String(raw.language ?? "").trim())
    ? String(raw.language).trim().toLowerCase()
    : "en";

  return {
    name,
    countryCode,
    language,
    htmlLang: countryCode ? `${language}-${countryCode}` : language,
    locale: countryCode ? `${language}_${countryCode}` : language,
    configured: Boolean(name || countryCode),
  };
}
