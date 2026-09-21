/**
 * Meeting Janitor Cron
 *
 * Deletes assets in the Cloudinary meetings folder that no database row points
 * at.
 *
 * This closes one specific hole.  The recorder uploads the mixdown and *then*
 * writes the row; if the process dies, or the database rejects the write, or
 * the upload succeeds on a retry that the first attempt also completed, the
 * asset exists and nothing references it.  Nobody will ever find it by hand,
 * and it is billed forever.
 *
 * Two safeguards, because this job deletes things:
 *
 *   - a minimum age, so an asset that was uploaded seconds ago and whose row is
 *     still being written is never a candidate;
 *   - dryRun, on by default, so an operator sees what it would remove before
 *     letting it remove anything.
 *
 * Gated internally on config.meetings.janitor.
 */

import cron from "node-cron";
import { createRequire } from "module";

import { prisma } from "../controllers/databaseController.js";
import {
  MEETINGS_FOLDER,
  deleteAsset,
  isCloudinaryConfigured,
  listFolderAssets,
} from "../services/cloudinaryService.js";

const require = createRequire(import.meta.url);
const config = require("../config.json");
const features = require("../features.json");

const settings = config.meetings?.janitor || {};
const SCHEDULE = settings.schedule || "30 4 * * *";
const MINIMUM_AGE_HOURS = Number(settings.minimumAgeHours) || 24;
/** Default true: the first run of a deleting job should only ever report. */
const DRY_RUN = settings.dryRun !== false;

/** Every public_id the database currently claims, across all four columns. */
async function referencedPublicIds() {
  const [recordings, comments, sessions] = await Promise.all([
    prisma.meetingRecordings.findMany({
      where: { OR: [{ storagePublicId: { not: null } }, { transcriptPublicId: { not: null } }] },
      select: { storagePublicId: true, transcriptPublicId: true },
    }),
    prisma.meetingComments.findMany({
      where: { audioPublicId: { not: null } },
      select: { audioPublicId: true },
    }),
    prisma.meetingSessions.findMany({
      where: { archivePublicId: { not: null } },
      select: { archivePublicId: true },
    }),
  ]);

  return new Set(
    [
      ...recordings.map((row) => row.storagePublicId),
      // Transcripts live in the same folder as `raw` assets, so leaving them out
      // of this set would have the janitor delete every live transcript it found.
      ...recordings.map((row) => row.transcriptPublicId),
      ...comments.map((row) => row.audioPublicId),
      ...sessions.map((row) => row.archivePublicId),
    ].filter(Boolean)
  );
}

export async function runMeetingJanitor(now = new Date()) {
  if (!isCloudinaryConfigured()) return;

  try {
    const referenced = await referencedPublicIds();
    const cutoff = new Date(now.getTime() - MINIMUM_AGE_HOURS * 3_600_000);

    // Audio and archives are stored as different resource types, so the folder
    // has to be listed once per type or half the orphans are invisible.
    const assets = [
      ...(await listFolderAssets(MEETINGS_FOLDER, { resourceType: "video" })),
      ...(await listFolderAssets(MEETINGS_FOLDER, { resourceType: "raw" })),
    ];

    const orphans = assets.filter(
      (asset) => !referenced.has(asset.publicId) && new Date(asset.createdAt) < cutoff
    );

    if (orphans.length === 0) return;

    const bytes = orphans.reduce((total, asset) => total + (asset.bytes || 0), 0);
    console.log(
      `[MeetingJanitorCron] ${orphans.length} orphan asset(s), ${(bytes / 1048576).toFixed(1)} MB` +
        (DRY_RUN ? " — dry run, nothing deleted" : "")
    );

    if (DRY_RUN) {
      for (const orphan of orphans) console.log(`[MeetingJanitorCron]   would delete ${orphan.publicId}`);
      return;
    }

    for (const orphan of orphans) {
      try {
        await deleteAsset(orphan.publicId, { resourceType: orphan.resourceType });
        console.log(`[MeetingJanitorCron] deleted ${orphan.publicId}`);
      } catch (error) {
        console.error(`[MeetingJanitorCron] could not delete ${orphan.publicId}:`, error?.message ?? error);
      }
    }
  } catch (error) {
    console.error("[MeetingJanitorCron] run failed:", error);
  }
}

if (features.meetings && settings.enabled === true) {
  cron.schedule(SCHEDULE, () => runMeetingJanitor()).start();
  console.log(
    `[MeetingJanitorCron] scheduled (${SCHEDULE})${DRY_RUN ? " in dry-run mode" : ""}`
  );
}
