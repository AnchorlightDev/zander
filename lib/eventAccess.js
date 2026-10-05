/**
 * lib/eventAccess.js
 *
 * Pure visibility logic for rank-locked events.  Deliberately free of any
 * database import so the rules are testable on their own, matching the
 * split used by lib/apiKeys.js.
 *
 * The three visibility modes an event can be in:
 *
 *   public   Anyone sees everything.  The historic default.
 *   private  Nobody sees it on the public site at all.  Used for internal
 *            planning and staff-only runs.
 *   rank     Only holders of one of the event's allowed LuckPerms groups see
 *            the full detail.  Everyone else either gets a locked teaser
 *            (teaserPublic = true) or does not see the event at all.
 *
 * "Locked" is about the *detail*, not the existence of the event: the teaser
 * is the whole point of the feature, since an event nobody can see cannot
 * persuade anyone to buy the rank that unlocks it.
 */

export const EVENT_VISIBILITY = ["public", "private", "rank"];

/**
 * Fields a locked teaser deliberately withholds.
 *
 * Everything not listed here (title, banner, logo, start/end, tags, featured)
 * stays visible — that is the teaser.  Hosts are withheld too: the line-up is
 * often the draw, and leaking it gives away the event.
 */
const LOCKED_FIELDS = [
  "description",
  "locationLabel",
  "locationType",
  "locationDiscordChannelId",
  "serverName",
  "serverIp",
  "externalLinks",
  "hosts",
];

/**
 * Lower-case, trim and de-duplicate a list of LuckPerms group names.
 *
 * LuckPerms group names are case-insensitive in practice but arrive with
 * whatever casing the caller typed, so every comparison in this module runs
 * against normalised values on both sides.
 *
 * @param value Array of slugs, a comma-separated string, or null.
 */
export function normaliseRankSlugs(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];

  const seen = new Set();
  for (const entry of raw) {
    if (entry === null || entry === undefined) continue;
    // Accept both bare slugs and the {rankSlug} row shape the session and the
    // event_rank_access table both use.
    const slug = String(
      typeof entry === "object" ? (entry.rankSlug ?? "") : entry
    )
      .trim()
      .toLowerCase();
    if (slug) seen.add(slug);
  }

  return [...seen];
}

/**
 * The LuckPerms groups the current visitor holds, as normalised slugs.
 *
 * Reads the session shape built in routes/sessionRoutes.js (`ranks` is an
 * array of {rankSlug}).  Returns an empty array for logged-out visitors, which
 * makes them fail every rank check without a separate branch at the call site.
 */
export function viewerRankSlugs(req) {
  return normaliseRankSlugs(req?.session?.user?.ranks);
}

/** The allowed-rank slugs attached to an event row, whatever shape they arrive in. */
export function eventRankSlugs(event) {
  return normaliseRankSlugs(event?.rankAccess ?? event?.allowedRanks);
}

/**
 * Decide what a given visitor may see of a given event.
 *
 * @param event      An event row, ideally with its rankAccess relation loaded.
 * @param viewerRanks Normalised slugs from viewerRankSlugs(req).
 * @param options.isStaff Staff bypass — dashboard previews render the real
 *                        page through the same template, and a reviewer has to
 *                        be able to check a locked event before publishing it.
 *
 * @returns {{visible: boolean, locked: boolean, requiredRanks: string[]}}
 *          `visible` is whether the event appears on the public site at all;
 *          `locked` is whether its detail must be redacted first.
 */
export function resolveEventAccess(event, viewerRanks = [], options = {}) {
  const visibility = event?.visibility || "public";

  if (visibility === "private") {
    return { visible: Boolean(options.isStaff), locked: false, requiredRanks: [] };
  }

  if (visibility !== "rank") {
    return { visible: true, locked: false, requiredRanks: [] };
  }

  const requiredRanks = eventRankSlugs(event);

  // A rank-locked event with no ranks selected would lock everyone out
  // including the people it was built for, so treat it as public rather than
  // silently hiding it from the whole server.
  if (requiredRanks.length === 0) {
    return { visible: true, locked: false, requiredRanks: [] };
  }

  if (options.isStaff) {
    return { visible: true, locked: false, requiredRanks };
  }

  const holders = normaliseRankSlugs(viewerRanks);
  const qualifies = holders.some((slug) => requiredRanks.includes(slug));

  if (qualifies) {
    return { visible: true, locked: false, requiredRanks };
  }

  return {
    visible: event?.teaserPublic !== false,
    locked: true,
    requiredRanks,
  };
}

/**
 * Strip the withheld fields from an event so a locked teaser can be rendered
 * with the same templates as the full page.
 *
 * Returns a copy — the caller may still be holding the full row for logging.
 */
export function redactLockedEvent(event) {
  const teaser = { ...event };
  for (const field of LOCKED_FIELDS) {
    teaser[field] = null;
  }
  teaser.hosts = [];
  teaser.isLocked = true;

  // An organiser who wrote public-safe copy gets to use it. Without this the
  // lock replaced their blurb with generated text that cannot say what the
  // event actually is -- which is the whole job of a teaser.
  if (event?.teaserDescription) {
    teaser.description = event.teaserDescription;
  }

  return teaser;
}

/**
 * Whether the unlock prompt for this event should sell a rank or just explain
 * the restriction.
 *
 * A "supporter event" is one whose allowed ranks include at least one group
 * flagged `meta.donator.1` in LuckPerms — asking a visitor to buy their way
 * into a staff-only or veteran-only event would be a dead end, so those get a
 * plain explanation instead of a store link.
 *
 * @param requiredRanks Slugs the event requires.
 * @param donatorSlugs  Slugs known to be purchasable (from rankMetaService).
 */
export function isSupporterEvent(requiredRanks, donatorSlugs) {
  const donators = normaliseRankSlugs(donatorSlugs);
  return normaliseRankSlugs(requiredRanks).some((slug) =>
    donators.includes(slug)
  );
}

/**
 * Turn the list of qualifying ranks into something a reader can act on.
 *
 * A locked event is usually opened to every donator tier *and* every staff
 * rank, so the raw list runs to a dozen-plus names -- "for Administrator,
 * Builder, Content Creator, Developer, Diamond, Events, Gold, Iron, Junior
 * Developer, Moderator, Senior Staff, Social Media, Staff or Systems Engineer
 * members" tells a prospective supporter nothing and reads as noise.
 *
 * On a supporter event the only names worth printing are the ones you can
 * actually buy, cheapest first -- that is the answer to "what do I need?".
 * Staff ranks are dropped because no reader of the prompt can obtain one.
 * Anything past the first few collapses into "and above".
 */
export function describeRequiredRanks(requiredRanks, rankMeta, supporter) {
  const slugs = normaliseRankSlugs(requiredRanks);
  if (slugs.length === 0) return "a special rank";

  const rows = slugs.map(
    (slug) => rankMeta?.get?.(slug) || { rankSlug: slug, displayName: slug }
  );

  // On a supporter event, only the purchasable ranks answer the question.
  const relevant = supporter ? rows.filter((r) => r.isDonator) : rows;
  const chosen = relevant.length > 0 ? relevant : rows;

  // Cheapest first: LuckPerms weight rises with seniority, so ascending
  // weight puts the lowest tier that unlocks it at the front.
  const sorted = [...chosen].sort(
    (a, b) =>
      (a.priority ?? 0) - (b.priority ?? 0) ||
      String(a.displayName).localeCompare(String(b.displayName))
  );

  const names = sorted.map((r) => r.displayName || r.rankSlug);

  if (names.length === 1) return names[0];
  if (names.length > MAX_NAMED_RANKS) {
    return `${names.slice(0, MAX_NAMED_RANKS).join(", ")} and above`;
  }
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

/** Past this many names the list stops informing and starts padding. */
const MAX_NAMED_RANKS = 3;

/**
 * Build the copy shown on the lock panel.
 *
 * Kept here rather than in the template so both the listing card and the
 * detail page say exactly the same thing, and so it can be asserted in tests.
 *
 * @param requiredRanks Slugs the event requires.
 * @param rankMeta      Map of slug -> {displayName}, for human-readable names.
 * @param supporter     Result of isSupporterEvent().
 * @param isLoggedIn    Logged-out visitors are told to sign in first, since
 *                      they may already hold the rank.
 * @param subject       The noun for the thing being gated ("event",
 *                      "discussion"). Forums reuse this so a rank-locked
 *                      board and a rank-locked event word the prompt
 *                      identically -- one place to change the wording.
 */
export function buildLockCopy(requiredRanks, rankMeta, supporter, isLoggedIn, subject = "event") {
  const rankList = describeRequiredRanks(requiredRanks, rankMeta, supporter);

  if (!isLoggedIn) {
    return {
      heading: "Members only",
      body: `This ${subject} is for ${rankList} members. Sign in to check your access.`,
      ctaLabel: "Sign In",
      ctaUrl: "/login",
      supporter,
      rankList,
    };
  }

  if (supporter) {
    return {
      heading: `Supporter ${subject}`,
      body: `The full details of this ${subject} are for ${rankList} members. Support the server to unlock it — and everything else that comes with the rank.`,
      ctaLabel: "Support the Server",
      ctaUrl: "/webstore",
      supporter,
      rankList,
    };
  }

  return {
    heading: `Restricted ${subject}`,
    body: `The full details of this ${subject} are only visible to ${rankList} members.`,
    ctaLabel: null,
    ctaUrl: null,
    supporter,
    rankList,
  };
}
