/**
 * lib/plainText.mjs
 *
 * Summernote HTML -> short plain text for meta descriptions and previews.
 *
 * One pass of /<[^>]+>/g can leave a tag behind ("<scr<b>ipt>" becomes
 * "<script>"), so tags are removed until nothing changes, and any stray angle
 * bracket left over is dropped. The output is still escaped wherever it is
 * rendered; this only keeps it from ever containing markup.
 */
export function stripTags(html) {
  let text = String(html ?? "");
  let previous;
  do {
    previous = text;
    text = text.replace(/<[^>]*>/g, "");
  } while (text !== previous);
  return text.replace(/[<>]/g, "");
}
