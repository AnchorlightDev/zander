# Zander Velocity

Zander Velocity formats network-wide chat directly on the proxy using LuckPerms rank data.

## LuckPerms Setup

Each LuckPerms group needs two meta keys set so the chat formatter can display a readable rank name and description in the hover tooltip.

### Required meta keys

| Key | Purpose | Fallback |
|-----|---------|---------|
| `displayname` | Human-readable rank name shown in hover title | Group prefix text, or `Member` |
| `rank_description` | One-line description shown beneath the rank name | `No description set for this rank.` |

### Commands

```
lp group <group> meta set displayname "Rank Name"
lp group <group> meta set rank_description "Short description of the rank."
```

**Example:**

```
lp group admin meta set displayname "Admin"
lp group admin meta set rank_description "Has full access to staff & server tools."
```

## Chat format

```
[Rank] Username: message
```

The bracketed rank prefix is hoverable and shows the rank display name and description.

## Disable backend chat formatters

Because Zander Velocity handles all chat formatting on the proxy, you **must** disable any chat formatting plugins on your backend servers (e.g. EssentialsX chat, ChatControl, LuckPerms chat formatting). If you do not, players will see duplicate or incorrectly formatted messages.
