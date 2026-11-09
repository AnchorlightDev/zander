# Docs update notes (for anchorlight.dev / ald-website)

These notes summarise what changed for the Zander docs. They are NOT the docs
themselves - product docs live on the ald-website repo
(https://anchorlight.dev/docs/products/zander), not in this repo.

## Announcements (features/announcements)

- The announcements page is now a **five-step write-once wizard** (Message,
  Platforms, Per-platform, Schedule, Review). One announcement ("post") can be
  published to several platforms at once: website banner, website popup,
  in-game tip, server-list MOTD, and **hologram**.
- **Holograms are now a platform of announcements.** The separate Holograms page,
  editor and `zander.web.holograms` permission have been removed. Everything is
  gated by `zander.web.announcements`. `/dashboard/holograms*` now 301-redirects
  to `/dashboard/announcements?platform=hologram`.
  - Hologram frames are managed from the announcements list: filter by
    platform = Hologram and pick a group to reorder frames (up/down).
  - Holograms gained a **start date** (in addition to the existing expiry, which
    now uses the shared end date). Countdown target, finished text, group and
    sort order are set on the hologram tab of the wizard.
- The hub API `GET /api/hologram/messages` is **unchanged** (same path, response
  shape, ordering and `hologram` scope). No plugin changes are needed.
- Expired announcements are now **disabled, not deleted**. They stay listed under
  the "Ended" status filter; deleting is a manual action.
- All announcement times are handled in **UTC**; the wizard converts the viewer's
  local time on submit.
- Docs to update: replace the old "Holograms" page with a "Hologram platform"
  section under Announcements; document the wizard steps, the status filters
  (active / scheduled / ended / disabled), and the permission change
  (`zander.web.holograms` removed, use `zander.web.announcements`).
- Regenerate the permissions reference tables: `node scripts/permissionsTable.mjs`
  (the `zander.web.holograms` row is gone).

## Scheduler (features/scheduler)

- The scheduler is now **general-purpose jobs** at `/dashboard/scheduler`. A job
  runs once or on a recurrence (daily/weekly/monthly, intervals, until date) in a
  chosen IANA timezone, and each run executes the job's **actions in order**.
- Action types: run a **server command** or a **saved routine**, send a **Discord
  embed**, **publish a forum draft**, **enable/disable an announcement post**, or
  send an **in-game broadcast**. An action can be set to let the run continue if it
  fails; otherwise a failure stops the run. A run is succeeded / partial / failed,
  and missed if it was more than the grace window late (default 6 hours, a setting).
- **Placeholders** in command / Discord / broadcast text: `{date}`, `{week}`,
  `{runNumber}` (with a configurable start, e.g. "The Drop #12"). `{{` and `}}`
  are literal braces; unknown placeholders are rejected on save.
- Tabs: Jobs, History (per-action results, live status for queued commands), and
  read-only views of forum threads with a publish time and announcement posts with
  future windows (so nothing is scheduled in two places invisibly).
- The old **Discord Embeds** scheduler and its `scheduledDiscordMessages` table are
  gone: existing rows were migrated into jobs (one Discord embed action each).
- Permission: `zander.web.scheduler` grants everything, including command actions.
  Its description is now "Schedule jobs: commands, Discord messages, forum,
  announcements, broadcasts". Every create/edit/delete/enable/disable/run-now is
  audit-logged.
- MCP: `scheduler_list_jobs`, `scheduler_get_job`, `scheduler_create_job`,
  `scheduler_update_job`, `scheduler_set_enabled`, `scheduler_list_runs`. There is
  no MCP "run now" (running fires real side effects, so it stays a human action).
- **Broadcast caveat to document:** an in-game broadcast queues the proxy `/alert`
  command on the executor slug `config.scheduler.broadcastSlug` (default "proxy").
  The Velocity proxy does not currently poll executor tasks, so that slug must point
  at a target that actually runs `/alert` network-wide.

Regenerate the permissions reference tables: `node scripts/permissionsTable.mjs`.
