import { describe, it, expect } from "vitest";
import {
  ATTENDEE_ROLE,
  REVEAL_MODE,
  VISIBILITY,
  buildViewer,
  canReadVisibility,
  effectiveRevealOffsetMs,
  isRevealed,
  readableVisibilities,
  revealWhere,
  selectVisibleComments,
  selectVisibleNotes,
  visibilityWhere,
} from "../../lib/meetings/visibility.mjs";

/**
 * Meeting minutes carry two different mechanisms and it matters that they stay
 * separate:
 *
 *   visibility — a real access control (public / attendees / speakers / private)
 *   reveal     — timing only, for someone who is already allowed to read it
 *
 * Both are applied in the query, never in a template.  A blurred <div> whose
 * text is in the page source is a styling effect, not a permission — so these
 * tests assert that a hidden note's BODY IS ABSENT from the payload, not merely
 * that a flag is set on it.
 */

const CHAIR = 1;
const SPEAKER = 2;
const ATTENDEE = 3;
const OBSERVER = 4;
const OUTSIDER = 5;

function viewerWithRole(userId, role, { isManager = false } = {}) {
  return buildViewer({
    userId,
    isManager,
    attendee: role ? { userId, role, removedAt: null } : null,
  });
}

const VIEWERS = {
  chair: viewerWithRole(CHAIR, ATTENDEE_ROLE.CHAIR),
  speaker: viewerWithRole(SPEAKER, ATTENDEE_ROLE.SPEAKER),
  attendee: viewerWithRole(ATTENDEE, ATTENDEE_ROLE.ATTENDEE),
  observer: viewerWithRole(OBSERVER, ATTENDEE_ROLE.OBSERVER),
  outsider: viewerWithRole(OUTSIDER, null),
  manager: viewerWithRole(9, null, { isManager: true }),
};

/** One note at each visibility, all authored by the chair. */
function notesAtEveryVisibility(authorUserId = CHAIR) {
  return [
    { noteId: 1, authorUserId, visibility: VISIBILITY.PUBLIC, body: "PUBLIC-BODY", revealMode: REVEAL_MODE.IMMEDIATE, agendaItemId: null },
    { noteId: 2, authorUserId, visibility: VISIBILITY.ATTENDEES, body: "ATTENDEES-BODY", revealMode: REVEAL_MODE.IMMEDIATE, agendaItemId: null },
    { noteId: 3, authorUserId, visibility: VISIBILITY.SPEAKERS, body: "SPEAKERS-BODY", revealMode: REVEAL_MODE.IMMEDIATE, agendaItemId: null },
    { noteId: 4, authorUserId, visibility: VISIBILITY.PRIVATE, body: "PRIVATE-BODY", revealMode: REVEAL_MODE.IMMEDIATE, agendaItemId: null },
  ];
}

/** Everything a payload would actually carry, flattened for searching. */
function serialise(rows) {
  return JSON.stringify(rows);
}

describe("visibility x viewer role", () => {
  const cases = [
    { role: "chair", expected: ["PUBLIC-BODY", "ATTENDEES-BODY", "SPEAKERS-BODY", "PRIVATE-BODY"] },
    { role: "speaker", expected: ["PUBLIC-BODY", "ATTENDEES-BODY", "SPEAKERS-BODY"] },
    { role: "attendee", expected: ["PUBLIC-BODY", "ATTENDEES-BODY"] },
    { role: "observer", expected: ["PUBLIC-BODY", "ATTENDEES-BODY"] },
    { role: "outsider", expected: ["PUBLIC-BODY"] },
    // A manager reaches speakers-level but NOT someone else's private note:
    // "private" the organiser can read is not private.
    { role: "manager", expected: ["PUBLIC-BODY", "ATTENDEES-BODY", "SPEAKERS-BODY"] },
  ];

  for (const { role, expected } of cases) {
    it(`a ${role} reads exactly ${expected.length} of the four`, () => {
      const visible = selectVisibleNotes(notesAtEveryVisibility(), { viewer: VIEWERS[role] });
      expect(visible.map((note) => note.body).sort()).toEqual([...expected].sort());
    });

    it(`a hidden body never appears anywhere in a ${role}'s payload`, () => {
      const visible = selectVisibleNotes(notesAtEveryVisibility(), { viewer: VIEWERS[role] });
      const payload = serialise(visible);

      const hidden = ["PUBLIC-BODY", "ATTENDEES-BODY", "SPEAKERS-BODY", "PRIVATE-BODY"].filter(
        (body) => !expected.includes(body)
      );

      for (const body of hidden) expect(payload).not.toContain(body);
    });
  }

  it("the chair's own private note is theirs alone", () => {
    // Authored by the chair; nobody else sees it, however senior.
    for (const role of ["speaker", "attendee", "observer", "outsider", "manager"]) {
      const visible = selectVisibleNotes(notesAtEveryVisibility(CHAIR), { viewer: VIEWERS[role] });
      expect(serialise(visible)).not.toContain("PRIVATE-BODY");
    }
  });

  it("an observer's own private note is visible to them and to nobody else", () => {
    const notes = notesAtEveryVisibility(OBSERVER);

    expect(selectVisibleNotes(notes, { viewer: VIEWERS.observer }).map((n) => n.body)).toContain(
      "PRIVATE-BODY"
    );
    expect(serialise(selectVisibleNotes(notes, { viewer: VIEWERS.chair }))).not.toContain(
      "PRIVATE-BODY"
    );
  });

  it("a soft-removed attendee loses attendee-level access", () => {
    const removed = buildViewer({
      userId: ATTENDEE,
      attendee: { userId: ATTENDEE, role: ATTENDEE_ROLE.ATTENDEE, removedAt: new Date() },
    });

    expect(readableVisibilities(removed)).toEqual([VISIBILITY.PUBLIC]);
    expect(serialise(selectVisibleNotes(notesAtEveryVisibility(), { viewer: removed }))).not.toContain(
      "ATTENDEES-BODY"
    );
  });

  it("a deleted note is never returned to anyone", () => {
    const notes = [
      { noteId: 1, authorUserId: CHAIR, visibility: VISIBILITY.PUBLIC, body: "DELETED-BODY", revealMode: REVEAL_MODE.IMMEDIATE, deletedAt: new Date() },
    ];
    expect(serialise(selectVisibleNotes(notes, { viewer: VIEWERS.chair }))).not.toContain("DELETED-BODY");
  });
});

describe("the where fragment enforces the same rule in SQL", () => {
  it("narrows an outsider to public only", () => {
    const where = visibilityWhere(VIEWERS.outsider);
    expect(where.OR[0]).toEqual({ visibility: { in: [VISIBILITY.PUBLIC] } });
  });

  it("gives an attendee public and attendees", () => {
    const where = visibilityWhere(VIEWERS.attendee);
    expect(where.OR[0].visibility.in).toEqual([VISIBILITY.PUBLIC, VISIBILITY.ATTENDEES]);
  });

  it("gives a speaker all three non-private levels", () => {
    const where = visibilityWhere(VIEWERS.speaker);
    expect(where.OR[0].visibility.in).toEqual([
      VISIBILITY.PUBLIC,
      VISIBILITY.ATTENDEES,
      VISIBILITY.SPEAKERS,
    ]);
  });

  it("reaches private rows only through the author clause", () => {
    const where = visibilityWhere(VIEWERS.attendee);
    expect(where.OR[1]).toEqual({ visibility: VISIBILITY.PRIVATE, authorUserId: ATTENDEE });
  });

  it("keys authorship on userId for comments", () => {
    const where = visibilityWhere(VIEWERS.attendee, { authorField: "userId" });
    expect(where.OR[1]).toEqual({ visibility: VISIBILITY.PRIVATE, userId: ATTENDEE });
  });

  it("emits no author clause at all for a signed-out caller", () => {
    const where = visibilityWhere(buildViewer({ userId: null }));
    expect(where.OR).toHaveLength(1);
  });

  it("lets a scheduled note through only once its time has passed", () => {
    const now = new Date("2026-03-01T00:00:00Z");
    const clause = revealWhere(VIEWERS.attendee, now).OR.find(
      (entry) => entry.revealMode === REVEAL_MODE.SCHEDULED
    );

    expect(clause.revealAt).toEqual({ not: null, lte: now });
  });

  it("does not gate a manager on reveal at all", () => {
    // The organiser has to be able to see what they are about to release.
    expect(revealWhere(VIEWERS.manager)).toEqual({});
  });
});

describe("on_playback reveal", () => {
  const item = { itemId: 7, startOffsetMs: 600_000 };

  function playbackNote(overrides = {}) {
    return {
      noteId: 1,
      authorUserId: CHAIR,
      visibility: VISIBILITY.ATTENDEES,
      revealMode: REVEAL_MODE.ON_PLAYBACK,
      body: "PLAYBACK-BODY",
      agendaItemId: 7,
      revealAtOffsetMs: null,
      ...overrides,
    };
  }

  it("falls back to the agenda item's start when the note names no offset", () => {
    expect(effectiveRevealOffsetMs(playbackNote(), item)).toBe(600_000);
  });

  it("prefers the note's own offset over the fallback", () => {
    expect(effectiveRevealOffsetMs(playbackNote({ revealAtOffsetMs: 120_000 }), item)).toBe(120_000);
  });

  it("uses 0 when there is neither, so minutes are not lost to an unstamped item", () => {
    // An item the chair never reached has a null startOffsetMs.  Failing closed
    // here would hide the minutes forever; failing open is right precisely
    // because on_playback is a deterrent, not a control.
    expect(effectiveRevealOffsetMs(playbackNote(), { itemId: 7, startOffsetMs: null })).toBe(0);
    expect(effectiveRevealOffsetMs(playbackNote({ agendaItemId: null }), null)).toBe(0);
  });

  it("is hidden one millisecond before the boundary", () => {
    const visible = selectVisibleNotes([playbackNote()], {
      viewer: VIEWERS.attendee,
      agendaItemById: new Map([[7, item]]),
      playbackOffsetMs: 599_999,
    });

    expect(visible).toHaveLength(0);
    expect(serialise(visible)).not.toContain("PLAYBACK-BODY");
  });

  it("is revealed exactly at the boundary", () => {
    const visible = selectVisibleNotes([playbackNote()], {
      viewer: VIEWERS.attendee,
      agendaItemById: new Map([[7, item]]),
      playbackOffsetMs: 600_000,
    });

    expect(visible.map((note) => note.body)).toEqual(["PLAYBACK-BODY"]);
  });

  it("is revealed straight away when the fallback resolves to 0", () => {
    const visible = selectVisibleNotes([playbackNote()], {
      viewer: VIEWERS.attendee,
      agendaItemById: new Map([[7, { itemId: 7, startOffsetMs: null }]]),
      playbackOffsetMs: 0,
    });

    expect(visible).toHaveLength(1);
  });

  it("is visible to its author before anyone has played anything", () => {
    const visible = selectVisibleNotes([playbackNote()], {
      viewer: VIEWERS.chair,
      agendaItemById: new Map([[7, item]]),
      playbackOffsetMs: 0,
    });

    expect(visible).toHaveLength(1);
  });
});

describe("scheduled reveal", () => {
  const note = {
    noteId: 1,
    authorUserId: CHAIR,
    visibility: VISIBILITY.ATTENDEES,
    revealMode: REVEAL_MODE.SCHEDULED,
    revealAt: new Date("2026-03-01T10:00:00Z"),
    body: "SCHEDULED-BODY",
  };

  it("is hidden before its time", () => {
    expect(isRevealed(note, { viewer: VIEWERS.attendee, now: new Date("2026-03-01T09:59:59Z") })).toBe(
      false
    );
  });

  it("is revealed at its time", () => {
    expect(isRevealed(note, { viewer: VIEWERS.attendee, now: new Date("2026-03-01T10:00:00Z") })).toBe(
      true
    );
  });

  it("stays hidden indefinitely with no time set", () => {
    // Unlike on_playback this fails CLOSED: a scheduled note is the mechanism
    // the docs point at for anything genuinely sensitive, so an unset time must
    // not read as "release it now".
    const noTime = { ...note, revealAt: null };
    expect(isRevealed(noTime, { viewer: VIEWERS.attendee, now: new Date("2099-01-01") })).toBe(false);
  });

  it("keeps the body out of the payload while it is hidden", () => {
    const visible = selectVisibleNotes([note], {
      viewer: VIEWERS.attendee,
      now: new Date("2026-02-01T00:00:00Z"),
    });
    expect(serialise(visible)).not.toContain("SCHEDULED-BODY");
  });
});

describe("comments", () => {
  it("apply visibility but no reveal — a held-back reply would read out of order", () => {
    const comments = [
      { commentId: 1, userId: CHAIR, visibility: VISIBILITY.PUBLIC, body: "C-PUBLIC" },
      { commentId: 2, userId: CHAIR, visibility: VISIBILITY.SPEAKERS, body: "C-SPEAKERS" },
      { commentId: 3, userId: OBSERVER, visibility: VISIBILITY.PRIVATE, body: "C-PRIVATE" },
    ];

    const asAttendee = selectVisibleComments(comments, { viewer: VIEWERS.attendee });
    expect(asAttendee.map((c) => c.body)).toEqual(["C-PUBLIC"]);
    expect(serialise(asAttendee)).not.toContain("C-SPEAKERS");
    expect(serialise(asAttendee)).not.toContain("C-PRIVATE");

    const asObserver = selectVisibleComments(comments, { viewer: VIEWERS.observer });
    expect(asObserver.map((c) => c.body).sort()).toEqual(["C-PRIVATE", "C-PUBLIC"]);
  });

  it("checks authorship on userId, not authorUserId", () => {
    const comment = { commentId: 1, userId: OBSERVER, visibility: VISIBILITY.PRIVATE, body: "x" };
    expect(canReadVisibility(comment, VIEWERS.observer, { authorField: "userId" })).toBe(true);
    expect(canReadVisibility(comment, VIEWERS.chair, { authorField: "userId" })).toBe(false);
  });
});
