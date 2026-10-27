# Forms & applications

Forms are built at `/dashboard/forms` (permission `zander.web.forms`) and served at `/forms/<slug>`. An `applications` row with a `linkedFormId` is a tile that points at one, so everything below applies to applications too.

## Gating

Two checks run before the questions render, and again on submit — posting straight to `/forms/<slug>` does not skip them.

| Gate | Stored on `forms` | Behaviour |
|---|---|---|
| Access code | `accessCode` | One shared code per form. Wrong codes are rejected plainly, with no lockout or attempt counter — it is a code to paste into an announcement, not a password. Accepted codes are remembered per session so a validation error does not force re-entry. |
| Requirements | `requirements` (JSON) | Playtime, clean record, and in-game/Discord consistency. Failure is a hard block and the message quotes the exact numbers on both sides. |
| Reapply cooldown | `reapplyCooldownDays` | After a **denial** only, counted from `reviewedAt`. Approved and pending submissions stay governed by `allowMultiple`. |

Rules live in `lib/formRequirements.mjs` (pure, unit-tested); the querying is in `services/formRequirementsService.js`. If a source is unreachable the gate **opens** rather than blocking everyone.

**Punishments count bans and mutes only.** Kicks and warnings are excluded — both are routinely automated or a first-line "please stop", and counting them would block a large share of ordinary players. Change `PUNISHMENT_TABLES` in `services/formRequirementsService.js` to include `litebans_kicks` / `litebans_warnings`.

## Discord activity tracking

The Discord consistency checks read `discordActivityDaily`, filled by `listeners/discordActivity.js`.

This is a **daily rollup, not a message log**: one row per user per day holding a count. No message content, no channel and no per-message timestamps are stored. Please do not extend it into a message log. Bots, DMs and other guilds are ignored, and counts are buffered in memory and flushed periodically rather than written per message.

```json
{
  "discord": {
    "activityTracking": true
  }
}
```

Absent means **on**: it is deliberately not gated on `features.forms`, because activity has to accumulate before anyone first enables a requirement that reads it.

Because of that, the table only has data from the day the listener was deployed. A 30-day Discord window is meaningless until 30 days after that, so while the rollup is younger than the window those two checks report as *skipped* rather than failing everyone. Turn that off with `skipUnmeasurableDiscord: false` in `evaluateRequirements`.

## Image uploads

The `images` field type uploads through the existing `POST /api/upload/image` and stores the returned metadata (`url`, `publicId`, `width`, `height`). The per-field maximum is hard-capped at 10 and re-enforced server-side, and every URL is checked against `CLOUDINARY_CLOUD_NAME` — a submitter cannot hand-craft an answer pointing somewhere else. **Image fields return 503 unless `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY` and `CLOUDINARY_API_SECRET` are set.**

## Ticket status thread

Where `createTicket` is on, the submission's ticket carries the decision. Each form supplies its own wording (`ticketPendingMessage`, `ticketApprovedMessage`, `ticketDeniedMessage`); blanks fall back to `lib/formTicketMessages.mjs`. `{form}`, `{submissionId}` and `{reviewer}` are substituted.

The reviewer's comment (`formSubmissions.reviewNotes`) is **shown to the applicant** from this release onwards. It was previously labelled and treated as internal, so `commentIsPublic` guards it: existing rows are `false` and stay withheld, and only decisions saved after this shipped set it `true`.

## Migrations

| Migration | Adds |
|---|---|
| `0047_form_field_config` | `formFields.config` — per-field settings (`maxImages`, scale bounds, `showIf`) |
| `0048_form_access_code` | `forms.accessCode` |
| `0049_form_requirements` | `forms.requirements` |
| `0050_discord_activity_daily` | `discordActivityDaily` |
| `0051_form_drafts` | `formDrafts` — autosaved answers, deleted on submission |
| `0052_form_reapply_cooldown` | `forms.reapplyCooldownDays` |
| `0053_form_ticket_messages` | The three ticket message columns, and `formSubmissions.commentIsPublic` |
