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

<!-- Part B (scheduler) notes are appended in checkpoint 14. -->
