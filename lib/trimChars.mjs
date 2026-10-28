/**
 * lib/trimChars.mjs
 *
 * Strip a repeated character from the ends of a string without a regex.
 * `/-+$/` looks harmless but is quadratic on a long run of the character that
 * does not end the string -- each start position rescans the run -- so these
 * are used for anything derived from user input.
 */
export function trimChar(value, ch, { start = true, end = true } = {}) {
  const s = String(value);
  let from = 0;
  let to = s.length;
  if (start) while (from < to && s[from] === ch) from++;
  if (end) while (to > from && s[to - 1] === ch) to--;
  return s.slice(from, to);
}
