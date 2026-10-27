# Permission reference

All permission nodes follow dot-notation and are managed via LuckPerms. Wildcard support is available (e.g. `zander.web.*` grants all `zander.web.X` nodes). The special `*` node grants full access.

## Web Dashboard

| Permission Node | Description |
|---|---|
| `zander.web.dashboard` | Access the main dashboard |
| `zander.web.logs` | View system logs and audit trails |
| `zander.web.announcements` | Create, edit, and view announcements |
| `zander.web.application` | Manage player applications |
| `zander.web.forms` | Build forms and review their submissions |
| `zander.web.server` | Manage game servers |
| `zander.web.rank` | Manage individual player ranks via the API |
| `zander.web.ranks` | Access the ranks dashboard page |
| `zander.web.ranks.permissions` | Grant and revoke Zander permissions on a rank |
| `zander.web.scheduler` | Schedule announcements/messages |
| `zander.web.vault` | Access vault management |
| `zander.web.bridge` | Manage bridge/integrations |
| `zander.web.badges` | Access the badge management dashboard (create, edit, assign, delete badges) |
| `zander.web.apikeys` | Issue, scope and revoke API client credentials |
| `zander.web.settings` | Edit site settings (site info, links, Discord IDs and webhooks, automation) |
| `zander.web.modules` | Switch modules (feature flags) on and off |
| `zander.web.pages` | Create, edit, publish and delete custom pages |
| `zander.web.menus` | Edit the top bar, header and footer menus |
| `zander.web.resources` | Manage resource categories and published resources, and decide overdue suggestions |
| `zander.web.resources.review` | Vote on resource suggestions (every holder counts towards the majority) |
| `zander.web.holograms` | Design in-game hologram frames (groups, countdowns, expiry) |
| `zander.web.users` | Access the user administration dashboard (view only; email addresses are masked) |
| `zander.web.users.email` | Reveal unmasked email addresses on the user administration pages |
| `zander.web.users.manage` | Edit user records from the user administration dashboard |

## Events

| Permission Node | Description |
|---|---|
| `zander.web.events` | Access the events dashboard (view only) |
| `zander.web.events.edit` | Create and edit events |
| `zander.web.events.review` | Review and publish events (implies edit access), and edit the default announcements new events start with |

## Webstore

| Permission Node | Description |
|---|---|
| `zander.web.webstore` | Access the webstore admin dashboard (purchases, command configuration) |
| `zander.web.webstore.manage` | Edit webstore products and command configuration |
| `zander.web.webstore.*` | Equivalent to both `zander.web.webstore` and `zander.web.webstore.manage` |

## Finance

| Permission Node | Description |
|---|---|
| `zander.web.finance` | View the finance dashboard (accounts, transactions, categories) |
| `zander.web.finance.manage` | Create, edit, and delete finance records |
| `zander.web.finance.*` | Equivalent to both `zander.web.finance` and `zander.web.finance.manage` |

## Support Tickets

| Permission Node | Description |
|---|---|
| `zander.web.ticket` | Access the support ticket dashboard |
| `zander.web.tickets` | Access ticket category listings |
| `zander.web.tickets.manage` | Create, rename and delete ticket categories, manage their Discord role access and post the support panel |
| `zander.web.tickets.{slug}` | Access a specific ticket category (dynamic, based on category slug) |
| `zander.web.tickets.*` | Access all ticket categories |
| `zander.web.ticket.escalate` | Escalate and de-escalate support tickets |
| `zander.web.tickets.manageparticipants` | Add and remove participants on support tickets |

## Punishments & Moderation

| Permission Node | Description |
|---|---|
| `zander.web.punishment.view` | View the global punishments list |
| `zander.web.punishment.manage` | Manage (edit/delete) punishments |
| `zander.web.punishments` | View punishments on user profiles |
| `zander.web.web-punishments` | Access the web-based punishment dashboard |
| `zander.web.audit` | View user audit entries on profiles |
| `zander.web.reports` | View player reports on profiles |

## Voting

| Permission Node | Description |
|---|---|
| `zander.web.voting` | Access the voting site management dashboard |

## Forums

| Permission Node | Description |
|---|---|
| `zander.web.forums` | Access the forums management dashboard |
| `zander.web.forums.{node}` | Free-form node set as a category's **view permission**; only holders see that category. The suffix is chosen by you when creating the category (e.g. `zander.web.forums.staff`, `zander.web.forums.supporter`) — it is not a fixed list |
| `zander.forums.moderate` | General forum moderation rights |
| `zander.forums.view` | View forum content |
| `zander.forums.post.delete` | Delete forum posts |
| `zander.forums.viewArchived` | View archived forum discussions |
| `zander.forums.discussion.sticky` | Sticky forum discussions |
| `zander.forums.discussion.lock` | Lock forum discussions |
| `zander.forums.discussion.archive` | Archive forum discussions |
| `zander.forums.category.manage` | Manage forum categories (admin dashboard) |

## Discord Punishments

| Permission Node | Description |
|---|---|
| `zander.discord.punish.warn` | Issue warnings to users via Discord |
| `zander.discord.punish.kick` | Kick users from the Discord server |
| `zander.discord.punish.ban` | Ban/unban users from the Discord server |
| `zander.discord.punish.mute` | Mute/unmute users in Discord |
| `zander.discord.punish.history` | View punishment history for users |

## Discord Commands

| Permission Node | Description |
|---|---|
| `zander.web.nicknamecheck` | Run the `/nicknamecheck` slash command (bulk-scans linked users for nickname mismatches) |

## Watch / Creator Content

| Permission Node | Description |
|---|---|
| `zander.watch.creator` | Marks the user as an eligible creator — their linked Twitch/YouTube content is synced to the `/watch` page |

---
