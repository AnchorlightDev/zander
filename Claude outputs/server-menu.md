---
title: Server Menu
description: An in-game menu of links and submenus, managed on the website and shown as Java dialogs and Bedrock forms.
sidebar_label: Server Menu
---

# Server Menu

The Server Menu is an in-game menu of links that you build on the website. Each button either opens a website link or opens a submenu.

Players open it:

- **Java 1.21.6+:** with the **Server Menu** button in the pause screen (Esc), with Quick Actions (**G** by default), or with `/menu`.
- **Bedrock**, through Geyser and Floodgate: with `/menu` or the optional menu item. Bedrock players see it as a native form that works with touch, mouse and controller.
- **Everyone:** with the optional menu item, if you turn it on.

You can limit any menu or button to certain servers, to Java or Bedrock, or to a permission. Nothing you change is shown to players until you **publish** it, and publishing does not need a restart.

## How it fits together

| Part | Job |
| --- | --- |
| **Dashboard → Minecraft → Server Menu** | Edit the draft, preview it, publish it, roll it back, and check sync status. |
| **zander-web API** (`/api/servermenu/*`, scope `servermenu`) | Serves the published revision to servers and records their health. |
| **`zander-servermenu`** (Paper plugin, one per backend server) | Fetches and checks each revision, keeps the last good copy on disk, and shows the menu. |

The website is the source of truth. Each server keeps the last menu that passed its checks in `plugins/zander-servermenu/cache/published.json`, so menus keep working while the website is down or a server can't reach it.

Velocity needs nothing: a menu only opens links and other menus.

## Setting it up

1. **Database.** Deploy zander-web, which runs `npx prisma migrate deploy` and applies migration `0078_server_menu`.
2. **Module.** Check that **Server Menu** is on at **Dashboard → Modules**. It is on by default.
3. **Permissions.** Give staff the [website nodes](#permissions) they need.
4. **API key per server.** At **Dashboard → API Keys**, create a key with the **`servermenu`** scope for each server that will run the plugin.
5. **Plugin.** Put `zander-servermenu-<version>.jar` in each Paper server's `plugins/` folder and start the server once. Then set these in `plugins/zander-servermenu/config.yml` and run `/servermenu reload`:
   - `api-url`: your site, for example `https://craftingforchrist.net`
   - `api-key`: that server's key
   - `server-id`: the server's name exactly as Velocity knows it, for example `survival`
6. **Bedrock** (optional). Install Floodgate on each backend server as well as the proxy, using the same key, so the plugin can tell which players are on Bedrock. Without Floodgate, every player gets Java dialogs.
7. **Build and publish.** Open **Dashboard → Minecraft → Server Menu**. The first time, the draft starts with links to your site, Discord, and the pages of the modules you have switched on. Edit it, then press **Publish**.

`/servermenu status` shows the revision the server is running and any sync problems. The website shows the same for every server at **Server Menu → Sync Status**.

## Editing the menu

The editor has three panels:

- **Menus** (left): every menu with its buttons. Drag buttons to reorder them, or drag them into another menu. **+ Link** adds a link button; **+ Submenu** adds a button together with a new menu for it to open.
- **Preview** (centre): what a player would see. Switch between **Java** and **Bedrock**, pick a server and pick whether the player has extra permissions. The buttons work, so you can click through the menus.
- **Properties** (right): the selected menu or button.

### Buttons

| Action | What it does |
| --- | --- |
| **Open a link** | Pick from **Pages** (from Dashboard → Pages), **Site** (the site's own pages, such as Events or Support, for modules that are switched on), **Platforms** (Discord and the other links in Settings → Links), or type an https link. |
| **Open a submenu** | Opens another menu. Pointing it at the main menu makes a **Home** button. |
| **Back** | Returns to the previous menu. With nothing to go back to, it closes the menu. |
| **Close** | Closes the menu. |

A link to a page from Dashboard → Pages follows that page: if you change the page's address, the next publish updates the button. If you unpublish the page, publishing is blocked until you point the button somewhere else.

**How links behave in game:**

- **Java:** Minecraft shows the address and asks before opening the browser.
- **Bedrock:** players see the address, or the text you set in **Shown to Bedrock players as**, to type into a browser themselves. Consoles can't open a browser.

### Who sees what

| Setting | Effect |
| --- | --- |
| **Enabled** | Off hides the button or menu everywhere. |
| **Editions** | Java, Bedrock, or both. |
| **Only on these servers** | Velocity server names. Leave empty for every server. |
| **Extra permission** | A LuckPerms node the player must also have. It is checked again when they press the button, so removing it takes effect straight away. |
| **Without the permission** | **Hide it**, **Show it locked**, or **Show it locked, with an explanation**. Players never see the node name. |

A button that opens a menu the player can't see is hidden as well. The main menu is always shown to everyone.

### Limits

These are enforced on the website and checked again by every server:

- Links must be **https** and on an **allowed host** (Menu Settings). Subdomains of an allowed host are included.
- Menus can't open each other in a loop. A Home button back to the main menu is fine.
- Menus can't nest deeper than **Deepest nesting**.
- A menu can't have more buttons than **Buttons per menu**.
- IDs, labels and lengths have fixed formats and limits.

Errors are listed under the editor; click one to jump to it. Errors block publishing, but warnings (such as a menu nothing links to) do not.

## Publishing, revisions and rollback

- **Save draft** (Ctrl+S) stores your work. Two people can't overwrite each other: a save based on an old copy is refused, with a prompt to reload.
- **Publish** freezes the draft as the next numbered **revision** and makes it live in one step. If two people publish at the same moment, one of them gets a "reload" message, and nothing is published twice.
- If the Bridge module is on, **Publish** can ask every server to switch straight away. Otherwise each server picks up the revision at its next check (30 seconds by default).
- **Revisions** lists every publish with who published it and their note.
  - **Roll back** publishes an earlier revision again as a new revision. You type the revision number to confirm.
  - **Edit from here** copies a revision into the draft without publishing anything. If you don't have the settings permission, only the menus are copied and the current settings are kept.
  - **Download** gives you the revision as JSON.
- **Activity** on the Revisions page records saves, publishes and rollbacks: who, when and what changed.

## What needs a restart

| Change | Takes effect |
| --- | --- |
| Anything published from the website | Without a restart, at each server's next check. |
| `api-url`, `api-key`, `server-id`, `sync.*`, `links.*`, `menu-item.*`, `messages.*` | After `/servermenu reload`. |
| `launcher.*` (the pause-screen and Quick Actions entry: on or off, labels) | After a server restart. Players who are already online see it after they reconnect. |
| `commands.aliases` | After a server restart. |

The pause-screen and Quick Actions entries are fixed while the server starts, because Minecraft builds its dialog registry then. So the plugin registers one permanent launcher, `zander:server_menu`, whose **Open** button opens the live menu. That launcher is the only part that needs a restart.

If another plugin or datapack also adds a pause-screen button, Minecraft groups them all under **Custom Options…**. The plugin adds itself to the existing list and never replaces anyone else's entry.

## Plugin reference

### Commands

| Command | Permission | Default |
| --- | --- | --- |
| `/menu` (plus `commands.aliases`, default `/links` and `/features`) | `zander.servermenu.menu` | everyone |
| `/servermenu status` | `zander.servermenu.admin` | op |
| `/servermenu sync`: fetch the live revision now | `zander.servermenu.reload` | op |
| `/servermenu reload`: reload `config.yml` and sync | `zander.servermenu.reload` | op |

`/recipe` is left alone. Minecraft's own `/recipe` command still works for operators.

### config.yml

```yaml
api-url: "https://craftingforchrist.net"
api-key: "zdr_..."           # this server's key, servermenu scope
server-id: "survival"        # the Velocity server name

sync:
  poll-interval-seconds: 30  # conditional requests: an unchanged menu is a 304
  heartbeat-interval-seconds: 60
  timeout-seconds: 10

launcher:                    # restart to change
  pause-screen: true
  quick-actions: true
  button-label: "Server Menu"
  title: "Server Menu"
  description: "Links to the website, guides and more."
  open-label: "Open"

commands:
  aliases: ["links", "features"]

links:
  allowed-hosts: []          # optional: also require links to be on this list

menu-item:                   # right-click to open; handy for Bedrock
  enabled: false
  slot: 8
  material: "minecraft:nether_star"
  name: "Server Menu"
  bedrock-only: false
```

### Requirements

- **Paper 26.2**, the version the rest of the Zander plugins are built for. Dialogs arrived in Paper 1.21.7, but this plugin is only built and tested against 26.2.
- **Java clients on 1.21.6 or newer** for dialogs, the pause-screen entry and Quick Actions.
- **Floodgate on the backend** (optional) for Bedrock forms. Geyser on the proxy alone can't tell Bedrock players apart.

## Permissions

| Permission node | Description |
| --- | --- |
| `zander.web.servermenu` | View the Server Menu editor, revisions and sync status (read-only). |
| `zander.web.servermenu.edit` | Edit drafts: menus, submenus and their links. |
| `zander.web.servermenu.publish` | Publish drafts and roll back to earlier revisions. |
| `zander.web.servermenu.settings` | Change settings, including which hosts buttons may link to. Also releases server ids on Sync Status. |

Editors can only link within the allowed hosts, so the settings permission controls where a menu can send players.

## API

All routes need an API key with the `servermenu` scope, sent in the `x-access-token` header. A dashboard session can't use them.

| Route | Purpose |
| --- | --- |
| `GET /api/servermenu/config` | The live revision: `{ revision, checksum, publishedAt, document }`. Send `If-None-Match: "<checksum>"` to get a `304` when it hasn't changed. `data` is `null` until the first publish. |
| `GET /api/servermenu/config/version` | Just `{ revision, checksum }`. |
| `GET /api/servermenu/revisions/:revision` | One revision, for diagnostics. |
| `POST /api/servermenu/heartbeat` | `{ instanceId, platform: "paper", pluginVersion, serverVersion, capabilities, activeRevision, activeChecksum, lastError }`. Answers with the live `{ revision, checksum }`. |
| `POST /api/servermenu/activation` | `{ instanceId, revision, status: "active" \| "rejected" \| "failed", message }`. |

The first API key to report an `instanceId` owns it, so one server's key can't report as another server. If you replace a server's key, release the id on **Sync Status**.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| "The server menu isn't available yet" | Nothing is published yet, or the server has never reached the website and has no cached copy. Run `/servermenu status`. |
| Status says the API key was refused | The key is wrong or revoked, or it lacks the `servermenu` scope. Keys can't be edited: create a new one and update `config.yml`. |
| "Another API key already reports as …" | Two servers share a `server-id`, or the key was replaced. Fix `server-id`, or release the id on Sync Status. |
| A server is **behind** on Sync Status | Look at its **Last problem**. A revision is rejected if it fails the plugin's checks, for example a link the server's own `links.allowed-hosts` doesn't allow. The server keeps its current menu and reports why. |
| A server is **stale** | It hasn't checked in for five minutes: it's offline or can't reach the site. Players still get its cached menu. |
| No pause-screen button | Check `launcher.pause-screen`, then restart and reconnect. The player needs Java 1.21.6+. With several entries, look under **Custom Options…**. |
| Bedrock players get nothing from `/menu` | Install Floodgate on the backend server. Without it, they're treated as Java players and sent dialogs, which Geyser can't show. |
