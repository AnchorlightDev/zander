# Discord booster rewards

Linked members who are **boosting your Discord server** can be given one or more LuckPerms ranks automatically. The ranks are removed when the boost ends.

Set it up in **Dashboard → Settings → Discord**:

- **Booster rewards**: the on/off switch. Turning it off removes the ranks it gave.
- **Booster reward ranks**: LuckPerms group names, one per line.

How it behaves:

- A boost starting or ending is picked up live, and a sweep every 30 minutes (`cron/boosterRewardSyncCron.js`) catches anything missed, such as members who left the server or boosts that ended while the bot was offline. Linking or unlinking Discord on the website takes effect straight away.
- Only real linked accounts qualify; placeholder accounts created by the support bot do not.
- Ranks are granted by queueing `lp user <uuid> parent add <group>` for the game servers, so the player does not need to be online. Using the Minecraft UUID means a later name change does not break removal.
- Each grant is recorded in `boosterRewardGrants`, so ending a boost removes only ranks this feature added. A player who already had one of the ranks, for example one they bought, keeps it.
- Discord does not let bots see Nitro itself, so this is based on boosting, which the bot can see.
