import { describe, it, expect } from "vitest";
import {
  ARCHIVE_STATUS,
  assertArchiveTransition,
  audioRemovalBlockedReason,
  canConfirmArchive,
  canRemoveAudio,
  canRequestArchive,
  canTransitionArchive,
  isPastRetention,
  planArchiveRequest,
} from "../../lib/meetings/archiveState.mjs";

/**
 * Deleting a meeting's audio is the one irreversible thing in this module, and
 * the guard in front of it is a human saying they have opened the archive and
 * it is intact.  Not the job that built it: a zip that streamed to completion
 * around a mid-build error is still a zip, and "it downloaded, so it's safe" is
 * how meetings get lost — nobody finds out until the year-old recording is
 * wanted.
 */

function session(overrides = {}) {
  return {
    sessionId: 1,
    status: "published",
    archiveStatus: ARCHIVE_STATUS.NONE,
    archivePath: null,
    archiveConfirmedAt: null,
    audioRemovedAt: null,
    endedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("transitions", () => {
  it("allows the happy path", () => {
    expect(canTransitionArchive(ARCHIVE_STATUS.NONE, ARCHIVE_STATUS.REQUESTED)).toBe(true);
    expect(canTransitionArchive(ARCHIVE_STATUS.REQUESTED, ARCHIVE_STATUS.BUILDING)).toBe(true);
    expect(canTransitionArchive(ARCHIVE_STATUS.BUILDING, ARCHIVE_STATUS.READY)).toBe(true);
  });

  it("allows a retry after a failure and a rebuild after a success", () => {
    expect(canTransitionArchive(ARCHIVE_STATUS.FAILED, ARCHIVE_STATUS.REQUESTED)).toBe(true);
    expect(canTransitionArchive(ARCHIVE_STATUS.READY, ARCHIVE_STATUS.REQUESTED)).toBe(true);
  });

  it("refuses to jump straight to ready", () => {
    expect(canTransitionArchive(ARCHIVE_STATUS.NONE, ARCHIVE_STATUS.READY)).toBe(false);
    expect(canTransitionArchive(ARCHIVE_STATUS.REQUESTED, ARCHIVE_STATUS.READY)).toBe(false);
    expect(() => assertArchiveTransition(ARCHIVE_STATUS.NONE, ARCHIVE_STATUS.READY)).toThrow();
  });

  it("refuses a second builder onto a session already building", () => {
    // A double-click on "build archive" must not start two archivers writing
    // the same path.
    expect(canTransitionArchive(ARCHIVE_STATUS.BUILDING, ARCHIVE_STATUS.REQUESTED)).toBe(false);
    expect(canRequestArchive(session({ archiveStatus: ARCHIVE_STATUS.BUILDING }))).toBe(false);
  });
});

describe("requesting", () => {
  it("is refused on a meeting that has not happened", () => {
    expect(canRequestArchive(session({ status: "draft" }))).toBe(false);
    expect(canRequestArchive(session({ status: "live" }))).toBe(false);
    expect(canRequestArchive(session({ status: "processing" }))).toBe(false);
  });

  it("is allowed once published or closed", () => {
    expect(canRequestArchive(session({ status: "published" }))).toBe(true);
    expect(canRequestArchive(session({ status: "closed" }))).toBe(true);
  });

  /**
   * The subtle one.  A rebuild must clear the old confirmation, or a never-
   * checked rebuild inherits the licence to delete audio that the old, checked
   * bundle had earned.
   */
  it("clears a previous confirmation when rebuilding", () => {
    const rebuilt = planArchiveRequest(
      session({
        archiveStatus: ARCHIVE_STATUS.READY,
        archivePath: "https://example.test/bundle.zip",
        archiveConfirmedAt: new Date("2026-02-01T00:00:00Z"),
      })
    );

    expect(rebuilt.archiveStatus).toBe(ARCHIVE_STATUS.REQUESTED);
    expect(rebuilt.archiveConfirmedAt).toBeNull();
    expect(rebuilt.archiveBuiltAt).toBeNull();
  });
});

describe("confirming", () => {
  it("needs a bundle that is actually ready", () => {
    expect(canConfirmArchive(session({ archiveStatus: ARCHIVE_STATUS.BUILDING }))).toBe(false);
    expect(canConfirmArchive(session({ archiveStatus: ARCHIVE_STATUS.FAILED }))).toBe(false);
  });

  it("needs a bundle that actually exists", () => {
    // A 'ready' row with no path is a bug; confirming it would licence deleting
    // the audio it was meant to replace.
    expect(canConfirmArchive(session({ archiveStatus: ARCHIVE_STATUS.READY, archivePath: null }))).toBe(
      false
    );
    expect(
      canConfirmArchive(
        session({ archiveStatus: ARCHIVE_STATUS.READY, archivePath: "https://example.test/b.zip" })
      )
    ).toBe(true);
  });

  it("cannot be confirmed twice", () => {
    expect(
      canConfirmArchive(
        session({
          archiveStatus: ARCHIVE_STATUS.READY,
          archivePath: "https://example.test/b.zip",
          archiveConfirmedAt: new Date(),
        })
      )
    ).toBe(false);
  });
});

describe("the audio deletion guard", () => {
  const ready = session({
    archiveStatus: ARCHIVE_STATUS.READY,
    archivePath: "https://example.test/bundle.zip",
  });

  it("blocks a session with no archive at all", () => {
    expect(canRemoveAudio(session())).toBe(false);
    expect(audioRemovalBlockedReason(session())).toMatch(/Build an archive/i);
  });

  it("blocks a session still building", () => {
    expect(canRemoveAudio(session({ archiveStatus: ARCHIVE_STATUS.BUILDING }))).toBe(false);
  });

  it("blocks a built-but-unconfirmed archive — the whole point of the guard", () => {
    expect(canRemoveAudio(ready)).toBe(false);
    expect(audioRemovalBlockedReason(ready)).toMatch(/confirm it opens/i);
  });

  it("allows deletion only once a person has confirmed the bundle", () => {
    const confirmed = { ...ready, archiveConfirmedAt: new Date("2026-02-01T00:00:00Z") };
    expect(canRemoveAudio(confirmed)).toBe(true);
    expect(audioRemovalBlockedReason(confirmed)).toBeNull();
  });

  it("refuses to run twice", () => {
    const already = {
      ...ready,
      archiveConfirmedAt: new Date(),
      audioRemovedAt: new Date(),
    };
    expect(canRemoveAudio(already)).toBe(false);
    expect(audioRemovalBlockedReason(already)).toMatch(/already been removed/i);
  });

  it("can be overridden only by an explicit opt-out, never by default", () => {
    // The retention cron threads this through from config.  It defaults to on,
    // so turning it off is a visible act in a file someone can read.
    expect(canRemoveAudio(session(), { requireArchiveConfirmed: false })).toBe(true);
    expect(canRemoveAudio(session(), {})).toBe(false);
    expect(canRemoveAudio(session())).toBe(false);
  });
});

describe("retention ageing", () => {
  const now = new Date("2027-01-01T00:00:00Z");

  it("is off when no retention period is configured", () => {
    expect(isPastRetention(session(), { retentionDays: 0, now })).toBe(false);
    expect(isPastRetention(session(), { retentionDays: null, now })).toBe(false);
    expect(isPastRetention(session(), { now })).toBe(false);
  });

  it("measures from when the meeting happened, not from when it was archived", () => {
    // Otherwise a late archive would keep old audio alive indefinitely.
    const old = session({ endedAt: new Date("2025-06-01T00:00:00Z") });
    expect(isPastRetention(old, { retentionDays: 365, now })).toBe(true);

    const recent = session({ endedAt: new Date("2026-12-01T00:00:00Z") });
    expect(isPastRetention(recent, { retentionDays: 365, now })).toBe(false);
  });

  it("falls back to startedAt, then createdAt, for a session that never ended cleanly", () => {
    const noEnd = { ...session({ endedAt: null }), startedAt: new Date("2025-01-01T00:00:00Z") };
    expect(isPastRetention(noEnd, { retentionDays: 30, now })).toBe(true);

    const neverRan = { endedAt: null, startedAt: null, createdAt: new Date("2025-01-01T00:00:00Z") };
    expect(isPastRetention(neverRan, { retentionDays: 30, now })).toBe(true);
  });

  /**
   * Ageing out is necessary but never sufficient: the retention cron still goes
   * through canRemoveAudio, which still wants the confirmation.
   */
  it("does not on its own permit deletion", () => {
    const old = session({ endedAt: new Date("2020-01-01T00:00:00Z") });
    expect(isPastRetention(old, { retentionDays: 30, now })).toBe(true);
    expect(canRemoveAudio(old)).toBe(false);
  });
});
