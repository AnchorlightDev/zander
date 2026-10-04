/**
 * lib/eventDefaultAnnouncements.js
 *
 * Deciding which site-wide default announcements an existing event or
 * template is still missing. No DB import, so it is unit-testable.
 */

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
