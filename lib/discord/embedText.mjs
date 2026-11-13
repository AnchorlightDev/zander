// Discord rejects embed field values over 1024 characters (discord.js throws
// before sending), so long text has to be split across fields.
export const EMBED_FIELD_VALUE_MAX = 1024;
export const EMBED_TITLE_MAX = 256;
export const EMBED_DESCRIPTION_MAX = 4096;

/** Cut text to `max` characters, ending in "…" when it was longer. */
export function clipEmbedText(text, max) {
  const value = text == null ? "" : String(text);
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * Split text into embed fields of at most 1024 characters each.
 * The first field gets `name`, the rest `${name} (cont.)`. A message longer
 * than maxFields fields is cut, with the last field ending in "…".
 */
export function chunkIntoFields(text, name, { maxFields = 4, inline = false } = {}) {
  const value = text ? String(text) : "";
  if (!value) return [{ name, value: "[empty]", inline }];

  const fields = [];
  for (let i = 0; i < value.length && fields.length < maxFields; i += EMBED_FIELD_VALUE_MAX) {
    fields.push({
      name: fields.length === 0 ? name : `${name} (cont.)`,
      value: value.slice(i, i + EMBED_FIELD_VALUE_MAX),
      inline,
    });
  }

  if (value.length > maxFields * EMBED_FIELD_VALUE_MAX) {
    const last = fields[fields.length - 1];
    last.value = `${last.value.slice(0, EMBED_FIELD_VALUE_MAX - 1)}…`;
  }
  return fields;
}

/**
 * Text to store for a Discord message: its content followed by one line per
 * attachment ("[Attachment] name: url"), so screenshots posted in a ticket
 * channel are not lost from the web transcript. `attachments` is a
 * discord.js Collection or any iterable of { name, url }.
 * Returns "" when the message has neither content nor attachments.
 */
export function messageTextWithAttachments(content, attachments) {
  const lines = [];
  const text = typeof content === "string" ? content.trim() : "";
  if (text) lines.push(text);

  const list = attachments?.values ? Array.from(attachments.values()) : Array.from(attachments || []);
  for (const attachment of list) {
    if (!attachment?.url) continue;
    lines.push(`[Attachment] ${attachment.name || "file"}: ${attachment.url}`);
  }
  return lines.join("\n");
}
