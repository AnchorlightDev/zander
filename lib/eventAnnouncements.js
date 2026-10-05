/**
 * lib/eventAnnouncements.js
 *
 * Timing for event announcements, and deciding which site-wide default
 * announcements an existing event or template is still missing. No DB
 * import, so it is unit-testable.
 */

/** Platforms delivered as a row in the site's own announcements table. */
export const SITE_ANNOUNCEMENT_PLATFORMS = ["motd", "tip", "web", "popup"];

/**
 * An announcement's offset as stored. 0 is a real offset ("at the start");
 * only blank or nonsense means none.
 */
export function parseOffsetMinutes(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * What makes two announcements "the same one": where it goes and when.
 * Label and wording are deliberately ignored, so an organiser who reworded a
 * default does not get a second copy of it.
 */
export function announcementKey(a) {
  const platform = a.platform || "discord";
  return [
    platform,
    a.triggerType || "before_event",
    Number(a.offsetMinutes) || 0,
    platform === "discord" ? a.channelId || "" : "",
  ].join("|");
}

/**
 * When an announcement would go out for an event, or null if its trigger has
 * no fixed time (on_publish) or the event lacks the time it needs.
 */
export function announcementSendTime(a, startAt, endAt) {
  const offsetMs = (Number(a.offsetMinutes) || 0) * 60000;
  switch (a.triggerType || "before_event") {
    case "before_event":
      return startAt ? new Date(new Date(startAt).getTime() - offsetMs) : null;
    case "event_start":
      return startAt ? new Date(startAt) : null;
    case "after_event":
      return endAt ? new Date(new Date(endAt).getTime() + offsetMs) : null;
    default:
      return null;
  }
}

/**
 * When a send time is due for a Discord announcement on a published event.
 * on_publish goes out straight away; a time already passed also goes out
 * straight away rather than never.
 */
export function discordScheduledFor(a, startAt, endAt, now = new Date()) {
  if ((a.triggerType || "before_event") === "on_publish") return new Date(now);
  const at = announcementSendTime(a, startAt, endAt);
  if (!at) return null;
  return at < now ? new Date(now) : at;
}

/**
 * The window a site announcement (MOTD, tip, web banner, popup) is shown in.
 * Null means open-ended on that side.
 */
export function siteAnnouncementWindow(a, startAt, endAt) {
  const offsetMs = (Number(a.offsetMinutes) || 0) * 60000;
  const start = startAt ? new Date(startAt) : null;
  const end = endAt ? new Date(endAt) : null;
  switch (a.triggerType || "before_event") {
    case "on_publish":
      return { startDate: null, endDate: end };
    case "before_event":
      return { startDate: start ? new Date(start.getTime() - offsetMs) : null, endDate: start };
    case "event_start":
      return { startDate: start, endDate: end };
    case "after_event":
      return { startDate: end ? new Date(end.getTime() + offsetMs) : null, endDate: null };
    default:
      return { startDate: null, endDate: end };
  }
}

/**
 * The defaults `existing` does not already have.
 *
 * For a published event, announcements are queued at publish time, so adding
 * one afterwards means queuing it now. An on_publish default would then post
 * as if the event were newly announced, and one whose time has passed would
 * post immediately and late -- both are left out.
 */
export function missingDefaults(existing, defaults, { published = false, startAt = null, endAt = null, now = new Date() } = {}) {
  const have = new Set((existing || []).map(announcementKey));
  const seen = new Set();

  return (defaults || []).filter((d) => {
    const key = announcementKey(d);
    if (have.has(key) || seen.has(key)) return false;
    seen.add(key);

    if (published) {
      if ((d.triggerType || "before_event") === "on_publish") return false;
      const sendAt = announcementSendTime(d, startAt, endAt);
      if (!sendAt || sendAt <= now) return false;
    }
    return true;
  });
}
