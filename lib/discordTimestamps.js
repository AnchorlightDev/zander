/**
 * lib/discordTimestamps.js
 *
 * Renders Discord's `<t:UNIX:STYLE>` timestamp tokens for the website.
 *
 * Event descriptions are written once and published to two places, so authors
 * use Discord's timestamp syntax to get a time that reads correctly in every
 * reader's own timezone.  Discord substitutes those tokens; a browser does
 * not, so on the website they came out as the literal text "<t:1790442000:F>".
 *
 * Summernote escapes a typed "<", so the token is normally stored as
 * "&lt;t:...&gt;" and survives sanitization as text.  Both forms are handled
 * here: the raw form shows up in descriptions written through the API or
 * copied from Discord.
 *
 * Deliberately free of any database or DOM import so the substitution rules
 * are testable on their own, matching the split used by lib/apiKeys.js.
 */

/**
 * Discord's timestamp style suffixes.
 *
 * `f` is Discord's default when a token carries no suffix at all.
 */
export const TIMESTAMP_STYLES = ["t", "T", "d", "D", "f", "F", "R"];

const DEFAULT_STYLE = "f";

/**
 * Matches both the escaped and raw token forms, with an optional style.
 *
 * The epoch is bounded to 1-14 digits so a runaway digit string cannot be
 * turned into markup, and the style is a single character from the fixed set
 * above.  Everything the replacement emits is therefore built from a bounded
 * number and one known letter, never from author-controlled text.
 */
const TOKEN_PATTERN = /(?:&lt;|<)t:(\d{1,14})(?::([tTdDfFR]))?(?:&gt;|>)/g;

/**
 * Server-side fallback text, shown before the client script runs and to
 * readers without JavaScript.
 *
 * Rendered in UTC because the server has no idea what timezone the reader is
 * in -- the client script replaces it with local time as soon as it runs.
 */
function fallbackText(epochSeconds, style) {
  const date = new Date(epochSeconds * 1000);
  if (Number.isNaN(date.getTime())) return "";

  const iso = date.toISOString();
  const datePart = iso.slice(0, 10);
  const timePart = iso.slice(11, 16);

  switch (style) {
    case "t":
      return `${timePart} UTC`;
    case "T":
      return `${iso.slice(11, 19)} UTC`;
    case "d":
    case "D":
      return datePart;
    case "R":
      // A relative label cannot be precomputed sensibly, so the fallback is
      // the absolute time it refers to.
      return `${datePart} ${timePart} UTC`;
    default:
      return `${datePart} ${timePart} UTC`;
  }
}

/**
 * Replace every Discord timestamp token in a fragment of already-sanitized
 * HTML with a span the client script localises.
 *
 * Call this at render time, never before storing: the stored description must
 * keep the raw tokens so the Discord copy still renders natively there.
 *
 * @param html Sanitized HTML, or null/undefined.
 * @returns The same HTML with tokens replaced; input returned as-is when there
 *          is nothing to do.
 */
export function renderDiscordTimestamps(html) {
  if (!html || typeof html !== "string") return html;
  if (!html.includes("t:")) return html;

  return html.replace(TOKEN_PATTERN, (match, epoch, style) => {
    const seconds = Number(epoch);
    if (!Number.isSafeInteger(seconds)) return match;

    const resolved = TIMESTAMP_STYLES.includes(style) ? style : DEFAULT_STYLE;
    return (
      `<span class="js-discord-ts" data-ts="${seconds}" data-ts-style="${resolved}">` +
      `${fallbackText(seconds, resolved)}</span>`
    );
  });
}

/**
 * The browser-side half: turns the spans above into local time.
 *
 * Returned as a string so the two templates that render event descriptions
 * share one implementation instead of keeping their own copies in sync.
 * Intended for direct inclusion inside a <script> block.
 */
export const DISCORD_TIMESTAMP_CLIENT_SCRIPT = `
document.querySelectorAll('.js-discord-ts').forEach(function (el) {
    var seconds = Number(el.dataset.ts);
    if (!Number.isFinite(seconds)) return;
    var d = new Date(seconds * 1000);
    if (isNaN(d)) return;
    var style = el.dataset.tsStyle || 'f';

    if (style === 'R') {
        var diff = d.getTime() - Date.now();
        var future = diff >= 0;
        var abs = Math.abs(diff);
        var units = [
            ['year', 31536000000], ['month', 2592000000], ['day', 86400000],
            ['hour', 3600000], ['minute', 60000], ['second', 1000],
        ];
        var label = 'now';
        for (var i = 0; i < units.length; i++) {
            var n = Math.floor(abs / units[i][1]);
            if (n >= 1) {
                label = n + ' ' + units[i][0] + (n === 1 ? '' : 's');
                label = future ? 'in ' + label : label + ' ago';
                break;
            }
        }
        el.textContent = label;
        el.title = d.toLocaleString();
        return;
    }

    var opts = {
        t: { hour: '2-digit', minute: '2-digit' },
        T: { hour: '2-digit', minute: '2-digit', second: '2-digit' },
        d: { year: 'numeric', month: '2-digit', day: '2-digit' },
        D: { year: 'numeric', month: 'long', day: 'numeric' },
        f: { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' },
        F: { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' },
    }[style] || { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' };

    el.textContent = d.toLocaleString(undefined, opts);
});
`;
