-- Meeting sessions: the meeting *itself*, as opposed to 0042's polls which only
-- decide when to hold it.  Agenda, recording, timestamped discussion, minutes
-- with visibility and timed reveal, catch-up tracking and archival.
--
-- ANCHOR RULE, and it governs every table below: every `*OffsetMs` column in
-- this module is milliseconds from `meetingSessions`.`startedAt` — the wall
-- clock of the meeting — and never from the start of an audio file.  A session
-- routinely has more than one recording (a bot reconnect, a separately uploaded
-- screen capture), each sitting at its own `startOffsetMs` on that one
-- timeline.  Anchoring to a file would make an agenda stamp, a comment and a
-- note mean different things depending on which file happened to be playing.
--
-- `userId` columns are plain INT with no foreign key to `users`, matching 0042:
-- a roster is a snapshot and must survive the user row being merged or removed.

-- One session per event.  A session hangs off an `events` row rather than a
-- poll, so a meeting called on the spot with no poll behind it still works, and
-- a recurring meeting is simply one event row (hence one session) per
-- occurrence.  The poll, where there was one, is reachable through
-- `events`.`meetingPollId`.
CREATE TABLE `meetingSessions` (
  `sessionId`           INT           NOT NULL AUTO_INCREMENT,
  `eventId`             INT           NOT NULL,
  -- draft | live | processing | published | closed | cancelled
  -- 'processing' is the window between the recording stopping and the mixdown
  -- and upload finishing, so the player can say "still processing" rather than
  -- rendering a session with no audio as though the audio had been lost.
  `status`              VARCHAR(16)   NOT NULL DEFAULT 'draft',
  -- 'roster' = only session attendees may view.  'open' = any logged-in user,
  -- for a session the organiser wants the whole team able to catch up on.
  `audienceMode`        VARCHAR(16)   NOT NULL DEFAULT 'roster',
  -- Written once, when capture begins, and never rewritten: it is the origin of
  -- every offset in this module, so moving it would silently invalidate every
  -- agenda stamp, comment position and note reveal already recorded.
  `startedAt`           DATETIME      NULL,
  `endedAt`             DATETIME      NULL,
  -- Authoritative meeting length.  Not derived from the recordings, because a
  -- meeting can keep running after the bot has been disconnected.
  `durationMs`          BIGINT        NULL,
  -- When catch-up comments close.  Drives the nag notification and the
  -- published -> closed transition.
  `responseDeadlineAt`  DATETIME      NULL,
  `summary`             TEXT          NULL,
  -- Default reveal behaviour for notes created on this session; an individual
  -- note may still override it.  immediate | on_playback | scheduled
  `noteRevealMode`      VARCHAR(16)   NOT NULL DEFAULT 'immediate',
  -- none | requested | building | ready | failed
  `archiveStatus`       VARCHAR(16)   NOT NULL DEFAULT 'none',
  `archivePath`         VARCHAR(512)  NULL,
  -- Cloudinary public_id of the archive bundle.  destroy() takes the id, not
  -- the URL, so without this the asset could never be deleted.
  `archivePublicId`     VARCHAR(255)  NULL,
  `archiveByteSize`     BIGINT        NULL,
  `archiveBuiltAt`      DATETIME      NULL,
  -- Set by a human who has checked the bundle actually opens.  Hosted audio may
  -- only be deleted once this is non-NULL: "the download finished, so it must
  -- be safe" is how meetings get lost.
  `archiveConfirmedAt`  DATETIME      NULL,
  -- When the hosted audio was dropped (archive confirmed, or retention policy).
  -- Notes, comments and transcript are kept; only the audio goes.
  `audioRemovedAt`      DATETIME      NULL,
  `createdByUserId`     INT           NOT NULL,
  `createdAt`           DATETIME      NOT NULL DEFAULT NOW(),
  `updatedAt`           DATETIME      NOT NULL DEFAULT NOW() ON UPDATE NOW(),
  PRIMARY KEY (`sessionId`),
  UNIQUE INDEX `meetingSessions_eventId_key` (`eventId`),
  INDEX `meetingSessions_status_idx` (`status`),
  INDEX `meetingSessions_responseDeadlineAt_idx` (`responseDeadlineAt`),
  INDEX `meetingSessions_archiveStatus_idx` (`archiveStatus`),
  FOREIGN KEY (`eventId`) REFERENCES `events`(`eventId`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Several rows per session is the normal case, not an error case: the bot
-- dropping and rejoining files a second row rather than corrupting the first,
-- and a separately uploaded screen recording is a third.
CREATE TABLE `meetingRecordings` (
  `recordingId`      INT           NOT NULL AUTO_INCREMENT,
  `sessionId`        INT           NOT NULL,
  -- discord_bot | upload | external
  `source`           VARCHAR(16)   NOT NULL DEFAULT 'discord_bot',
  -- Cloudinary delivery URL once uploaded; a local filesystem path while the
  -- mixdown still sits on disk, or permanently on a box with no Cloudinary
  -- configured, so a dev session is still playable.
  `storagePath`      VARCHAR(512)  NOT NULL,
  -- Cloudinary public_id.  Required to delete the asset — the API's destroy()
  -- takes the id, not the URL — so persisting only the URL would leave an asset
  -- nothing can ever remove.  NULL while the file is local.
  `storagePublicId`  VARCHAR(255)  NULL,
  `mimeType`         VARCHAR(64)   NULL,
  -- BIGINT: a long meeting's audio comfortably exceeds the signed INT ceiling.
  `byteSize`         BIGINT        NULL,
  `durationMs`       BIGINT        NULL,
  -- Where this file sits on the session timeline (ms from session startedAt).
  -- A reconnect files a second recording at a non-zero offset rather than
  -- pretending the gap did not happen.
  `startOffsetMs`    BIGINT        NOT NULL DEFAULT 0,
  -- Set only for a per-speaker track that was deliberately kept.  The default
  -- pipeline mixes down to one file and leaves this NULL.
  `trackUserId`      INT           NULL,
  `trackIndex`       INT           NOT NULL DEFAULT 0,
  `discordGuildId`   VARCHAR(32)   NULL,
  `discordChannelId` VARCHAR(32)   NULL,
  -- pending | running | done | failed | skipped.  Consumed by the transcription
  -- cron; 'skipped' is an explicit organiser decision, distinct from 'failed'.
  `transcriptStatus` VARCHAR(16)   NOT NULL DEFAULT 'pending',
  `transcriptPath`   VARCHAR(512)  NULL,
  -- Cloudinary public_id of the transcript.  A transcript of a staff meeting is
  -- exactly as sensitive as the audio, so it is uploaded `authenticated` too —
  -- which means the URL alone cannot fetch it and the id has to be kept in
  -- order to sign a request, and in order to delete it later.
  `transcriptPublicId` VARCHAR(255) NULL,
  `transcriptError`  TEXT          NULL,
  `createdAt`        DATETIME      NOT NULL DEFAULT NOW(),
  `updatedAt`        DATETIME      NOT NULL DEFAULT NOW() ON UPDATE NOW(),
  PRIMARY KEY (`recordingId`),
  INDEX `meetingRecordings_sessionId_idx` (`sessionId`),
  INDEX `meetingRecordings_transcriptStatus_idx` (`transcriptStatus`),
  -- The janitor cron reconciles the Cloudinary folder against this column, so
  -- it is looked up by value rather than by session.
  INDEX `meetingRecordings_storagePublicId_idx` (`storagePublicId`),
  FOREIGN KEY (`sessionId`) REFERENCES `meetingSessions`(`sessionId`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Who was speaking when, logged live by the recorder.
--
-- This is what buys accurate diarisation — who said what, on the transcript —
-- from a single mixed-down file, without keeping a separate audio track per
-- speaker.  Per-speaker PCM is ~11.5 MB per minute each; this is a few rows.
CREATE TABLE `meetingSpeakingIntervals` (
  `intervalId`    INT         NOT NULL AUTO_INCREMENT,
  `sessionId`     INT         NOT NULL,
  -- Nullable: the recorder knows a Discord id, and the speaker may have no
  -- linked website account.  The raw Discord id is kept either way, so the
  -- interval is still attributable if they link one later.
  `userId`        INT         NULL,
  `discordUserId` VARCHAR(32) NULL,
  `startOffsetMs` BIGINT      NOT NULL,
  -- NULL while the burst is still open; filled in when the speaker stops.
  `endOffsetMs`   BIGINT      NULL,
  `createdAt`     DATETIME    NOT NULL DEFAULT NOW(),
  PRIMARY KEY (`intervalId`),
  INDEX `meetingSpeakingIntervals_session_start_idx` (`sessionId`, `startOffsetMs`),
  INDEX `meetingSpeakingIntervals_userId_idx` (`userId`),
  FOREIGN KEY (`sessionId`) REFERENCES `meetingSessions`(`sessionId`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- The agenda, which doubles as the recording's chapter list.  That is what
-- makes a ninety minute recording navigable with no AI chaptering anywhere in
-- the pipeline: the chair advancing the agenda stamps the timeline as they go.
CREATE TABLE `meetingAgendaItems` (
  `itemId`             INT           NOT NULL AUTO_INCREMENT,
  `sessionId`          INT           NOT NULL,
  `title`              VARCHAR(255)  NOT NULL,
  -- The organiser's pre-meeting description of the item.  What was actually
  -- said about it is minutes, and minutes live in `meetingNotes`.
  `brief`              TEXT          NULL,
  `orderIndex`         INT           NOT NULL DEFAULT 0,
  -- Stamped when the chair reaches the item.  An item never reached stays NULL
  -- and renders as "not discussed" — which is real information, so it has to
  -- stay distinguishable from an item that started at offset 0.
  `startOffsetMs`      BIGINT        NULL,
  `endOffsetMs`        BIGINT        NULL,
  -- pending | discussed | deferred | decided
  `status`             VARCHAR(16)   NOT NULL DEFAULT 'pending',
  -- Hide items the meeting has not reached yet from catch-up viewers, so a
  -- partly-run agenda does not leak what is coming.  The chair always sees the
  -- whole agenda regardless.
  `hiddenUntilReached` BOOLEAN       NOT NULL DEFAULT false,
  `createdAt`          DATETIME      NOT NULL DEFAULT NOW(),
  `updatedAt`          DATETIME      NOT NULL DEFAULT NOW() ON UPDATE NOW(),
  PRIMARY KEY (`itemId`),
  INDEX `meetingAgendaItems_session_order_idx` (`sessionId`, `orderIndex`),
  FOREIGN KEY (`sessionId`) REFERENCES `meetingSessions`(`sessionId`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Who is expected at the session — the generic equivalent of 0042's
-- `meetingPollInvitees`.  Populated by expanding LuckPerms ranks, by copying
-- the poll roster when the event carries a `meetingPollId`, or by hand.
CREATE TABLE `meetingSessionAttendees` (
  `attendeeId`   INT         NOT NULL AUTO_INCREMENT,
  `sessionId`    INT         NOT NULL,
  `userId`       INT         NOT NULL,
  -- poll | role | manual
  `source`       VARCHAR(16) NOT NULL DEFAULT 'role',
  `viaRankSlug`  VARCHAR(36) NULL,
  -- chair | speaker | attendee | observer.
  -- Set by the chair and never inferred from who happened to talk: a quiet
  -- presenter has to keep speaker-level access to notes, and a chatty observer
  -- must not gain it.
  `role`         VARCHAR(16) NOT NULL DEFAULT 'attendee',
  -- 0 = on the roster but with no usable website login, so they are shown to
  -- the organiser rather than silently dropped from the outstanding list.
  `canRespond`   BOOLEAN     NOT NULL DEFAULT true,
  `attendedLive` BOOLEAN     NOT NULL DEFAULT false,
  `notifiedAt`   DATETIME    NULL,
  -- Soft remove, so comments and notes by this person survive a remove/re-add.
  `removedAt`    DATETIME    NULL,
  `createdAt`    DATETIME    NOT NULL DEFAULT NOW(),
  PRIMARY KEY (`attendeeId`),
  UNIQUE INDEX `meetingSessionAttendees_sessionId_userId_key` (`sessionId`, `userId`),
  INDEX `meetingSessionAttendees_userId_idx` (`userId`),
  FOREIGN KEY (`sessionId`) REFERENCES `meetingSessions`(`sessionId`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Live and catch-up comments share ONE table, so the discussion on an agenda
-- item reads as a single thread rather than two lists that every view has to
-- merge.  `postedLive` is the only thing that distinguishes them.
CREATE TABLE `meetingComments` (
  `commentId`        INT           NOT NULL AUTO_INCREMENT,
  `sessionId`        INT           NOT NULL,
  -- SET NULL, not CASCADE: deleting an agenda item must not delete the
  -- discussion that happened under it.  The comment keeps its `atOffsetMs` and
  -- simply becomes a general comment.
  `agendaItemId`     INT           NULL,
  `parentCommentId`  INT           NULL,
  `userId`           INT           NOT NULL,
  -- text | voice
  `kind`             VARCHAR(8)    NOT NULL DEFAULT 'text',
  -- The point on the session timeline this comment is about.  NULL = a general
  -- comment on the meeting rather than on a moment in it.
  `atOffsetMs`       BIGINT        NULL,
  `body`             TEXT          NULL,
  `audioPath`        VARCHAR(512)  NULL,
  -- Same reason as on recordings: the id, not the URL, is what deletes it.
  `audioPublicId`    VARCHAR(255)  NULL,
  `audioDurationMs`  BIGINT        NULL,
  `transcript`       TEXT          NULL,
  -- pending | running | done | failed | skipped.  Defaults to 'skipped' because
  -- most comments are text and have nothing to transcribe; a voice note is
  -- written as 'pending' explicitly.
  `transcriptStatus` VARCHAR(16)   NOT NULL DEFAULT 'skipped',
  -- public | attendees | speakers | private
  `visibility`       VARCHAR(16)   NOT NULL DEFAULT 'attendees',
  `postedLive`       BOOLEAN       NOT NULL DEFAULT false,
  `createdAt`        DATETIME      NOT NULL DEFAULT NOW(),
  `updatedAt`        DATETIME      NOT NULL DEFAULT NOW() ON UPDATE NOW(),
  -- Soft delete, so a reply thread stays readable when a parent is withdrawn.
  `deletedAt`        DATETIME      NULL,
  PRIMARY KEY (`commentId`),
  INDEX `meetingComments_session_offset_idx` (`sessionId`, `atOffsetMs`),
  INDEX `meetingComments_agendaItemId_idx` (`agendaItemId`),
  INDEX `meetingComments_parentCommentId_idx` (`parentCommentId`),
  INDEX `meetingComments_userId_idx` (`userId`),
  INDEX `meetingComments_transcriptStatus_idx` (`transcriptStatus`),
  FOREIGN KEY (`sessionId`) REFERENCES `meetingSessions`(`sessionId`) ON DELETE CASCADE,
  FOREIGN KEY (`agendaItemId`) REFERENCES `meetingAgendaItems`(`itemId`) ON DELETE SET NULL,
  FOREIGN KEY (`parentCommentId`) REFERENCES `meetingComments`(`commentId`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- The minutes.
--
-- A table rather than a `notes` column on the agenda item, for two reasons that
-- both turn up in an ordinary meeting: one item routinely carries notes at
-- different visibilities (the summary everyone sees, and the part only speakers
-- see), and each note reveals on its own schedule.
CREATE TABLE `meetingNotes` (
  `noteId`           INT         NOT NULL AUTO_INCREMENT,
  `sessionId`        INT         NOT NULL,
  -- SET NULL for the same reason as on comments: losing the item must not lose
  -- the decision recorded under it.
  `agendaItemId`     INT         NULL,
  `authorUserId`     INT         NOT NULL,
  -- note | decision | action.  'action' here is a plain line of text; action
  -- items with an assignee and a due date are a later migration.
  `kind`             VARCHAR(16) NOT NULL DEFAULT 'note',
  `body`             TEXT        NOT NULL,
  -- public | attendees | speakers | private
  `visibility`       VARCHAR(16) NOT NULL DEFAULT 'attendees',
  -- immediate | on_playback | scheduled
  `revealMode`       VARCHAR(16) NOT NULL DEFAULT 'immediate',
  -- For 'on_playback'.  NULL falls back to the agenda item's `startOffsetMs`,
  -- so the common case — reveal this note when the viewer reaches the item it
  -- belongs to — needs nothing filled in.
  `revealAtOffsetMs` BIGINT      NULL,
  -- For 'scheduled'.  Unlike on_playback this is genuinely enforceable: it does
  -- not depend on the client being honest about where it has played to.
  `revealAt`         DATETIME    NULL,
  `orderIndex`       INT         NOT NULL DEFAULT 0,
  `createdAt`        DATETIME    NOT NULL DEFAULT NOW(),
  `updatedAt`        DATETIME    NOT NULL DEFAULT NOW() ON UPDATE NOW(),
  `deletedAt`        DATETIME    NULL,
  PRIMARY KEY (`noteId`),
  INDEX `meetingNotes_session_order_idx` (`sessionId`, `orderIndex`),
  INDEX `meetingNotes_agendaItemId_idx` (`agendaItemId`),
  INDEX `meetingNotes_visibility_idx` (`visibility`),
  INDEX `meetingNotes_authorUserId_idx` (`authorUserId`),
  FOREIGN KEY (`sessionId`) REFERENCES `meetingSessions`(`sessionId`) ON DELETE CASCADE,
  FOREIGN KEY (`agendaItemId`) REFERENCES `meetingAgendaItems`(`itemId`) ON DELETE SET NULL
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- How far through the recording each viewer has got.
--
-- Deliberately separate from `meetingSessionAttendees`: an 'open' session has
-- viewers who were never on the roster, and this row is written orders of
-- magnitude more often than an attendee row, so keeping them apart avoids
-- churning the roster table on every scrub of the player.
CREATE TABLE `meetingSessionProgress` (
  `sessionId`    INT      NOT NULL,
  `userId`       INT      NOT NULL,
  `lastOffsetMs` BIGINT   NOT NULL DEFAULT 0,
  `completedAt`  DATETIME NULL,
  -- Set on the viewer's first comment, or on an explicit "I'm caught up".
  -- This — not lastOffsetMs — is what the organiser's outstanding-responses
  -- view reads: scrubbing to the end is not the same as responding.
  `respondedAt`  DATETIME NULL,
  `updatedAt`    DATETIME NOT NULL DEFAULT NOW() ON UPDATE NOW(),
  PRIMARY KEY (`sessionId`, `userId`),
  INDEX `meetingSessionProgress_userId_idx` (`userId`),
  FOREIGN KEY (`sessionId`) REFERENCES `meetingSessions`(`sessionId`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
