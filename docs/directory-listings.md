# Server directory listings — reference copy

Write once, paste everywhere. Server-list directories are where most inbound
discovery currently comes from, and a listing that says "unknown modes" converts
nobody.

Every listing should say the same things in the same words. Where a directory
gives you fewer characters, cut from the bottom of the long description rather
than rewriting it — rewriting per site is how five listings end up describing
five different servers.

Facts marked **[CONFIRM]** could not be taken from the repository. Fill them in
once, here, then paste.

---

## Connection details

**[CONFIRM] — the only values in the repository are documentation placeholders
(`play.example.net`, `bedrock.example.net`), so these are not the live ones.**

| | Address | Port |
|---|---|---|
| Java Edition | `[CONFIRM]` | default (25565) unless stated |
| Bedrock Edition | `[CONFIRM]` | `[CONFIRM]` |

Put the real values into `config.json` under `connection` before publishing
anywhere. Every page on the site reads from there, so the site and the listings
cannot then disagree.

> **Known inconsistency to settle first.** The live site has been rendering
> *different Bedrock ports on different pages* — `/ranks` and `/vault` disagree.
> Confirm which is correct before copying it into a dozen directories, because
> a wrong port in a listing is invisible: the player just fails to connect and
> leaves.

---

## Short description

Under ~150 characters, for listing cards and search results.

> A Christian Minecraft community on Java and Bedrock. Australian-hosted,
> family-friendly, and running since [CONFIRM: founding year].

---

## Medium description

Two or three sentences, for directories with a summary field.

> Crafting For Christ is a Christian Minecraft community playing together on
> Java and Bedrock Edition. We are Australian-hosted, so local players get a
> low-ping connection instead of playing across an ocean. Everyone is welcome,
> whether you are here for the faith, the building, or both.

---

## Long description

For the main listing body. Cut from the bottom if you run out of room.

> **Crafting For Christ** is a Christian Minecraft community that has been
> playing together since [CONFIRM: founding year]. We are a place to build,
> play and belong — a community that cares as much about the people as the
> blocks.
>
> **Java and Bedrock, both welcome.** Play from a PC, a phone or a tablet.
> Bedrock players get their own address and port, with step-by-step joining
> instructions for every device.
>
> **Australian-hosted.** Most communities in this space are hosted in North
> America. We are not, which means local players get a connection that actually
> feels responsive.
>
> **Game modes:** [CONFIRM — see below].
>
> **A community, not just a server.** Forums, community events, a player shop
> directory, ranks, and an active Discord. Nothing here requires you to spend
> anything.
>
> **A map archive going back years.** Every past world is catalogued with its
> dates, its seed and a download, so you can go back and visit the places the
> community built.
>
> **Safe and moderated.** Published rules, a visible moderation log, and a
> staff team you can actually reach.

---

## Game modes

**[CONFIRM] — not derivable from the repository.** The `servers` table stores a
display name, a connection address and a type, but no mode list, so there is
nothing here to read.

To see what the site currently advertises:

```sql
SELECT serverId, displayName, serverConnectionAddress, serverType
FROM servers ORDER BY position;
```

Write the confirmed list here, then reuse it verbatim in every directory:

- [CONFIRM]
- [CONFIRM]

Use the directory's own vocabulary where it has one (Survival, SMP, Creative,
Skyblock, Minigames), because that is what their filters search on. Do not
invent a mode to fill a filter.

---

## Tag set

Most directories cap tags. Use them in this order and stop when you run out.

```
Christian, Survival, Community, Family Friendly, Bedrock, Crossplay,
Australia, SMP, Economy, Events, No Pay To Win
```

Only claim **No Pay To Win** if that is true of the current rank perks — it is
a tag players actively filter on and a listing that misuses it gets reported.
Only claim **Crossplay** and **Bedrock** once the Bedrock address above is
confirmed live.

---

## Links

| | |
|---|---|
| Website | https://craftingforchrist.net |
| Discord | [CONFIRM — `config.siteConfiguration.platforms.discord` is currently a bare `https://discord.com/`, not an invite link] |
| Store | https://crafting-for-christ.tebex.io |
| Knowledge base | https://kb.craftingforchrist.net/ |
| YouTube | https://www.youtube.com/channel/UCeijz6MNnya85LprMjPmYag |
| Twitch | https://www.twitch.tv/craftingforchrist |
| Facebook | https://www.facebook.com/craft4christ/ |
| Instagram | https://instagram.com/craftingforchrist |
| Reddit | https://www.reddit.com/r/craftingforchrist/ |
| Issue tracker | https://github.com/craftingforchrist/Issues/issues |

---

## Where we are listed

**[CONFIRM] — the repository has no record of this.** Fill the table in as you
audit, then keep it as the checklist for the next time anything changes.

| Directory | URL of our listing | Login held by | Last reviewed | Status |
|---|---|---|---|---|
| Minecraft-MP | | | | |
| Minecraft Server List | | | | |
| TopG | | | | |
| Planet Minecraft | | | | |
| MCSL / minecraftservers.org | | | | |
| Best Minecraft Servers | | | | |
| | | | | |

For each one, check in this order:

1. **Connection details** — the single thing that makes a listing useless if wrong.
2. **Game modes** — at least one directory currently says "unknown modes".
3. **Description** — replace with the copy above.
4. **Tags** — as above, truthfully.
5. **Banner and links** — current, and pointing at https, not a dead subdomain.
6. **Vote hook** — if the directory offers voting rewards and we use them,
   confirm the callback still works.

---

## When any of this changes

Update this file first, then the listings. The order matters: a directory you
updated from memory is a directory nobody can check.

Connection details are the exception — those live in `config.json` under
`connection`, and this document should quote them rather than restate them.
