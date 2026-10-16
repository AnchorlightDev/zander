# zander

Documentation: [https://modularsoft.org/docs/products/zander](https://modularsoft.org/docs/products/zander)

Product docs:
- [Private messaging (Zander Velocity)](docs/private-messaging.md)
- [Custom portals & server navigation (Zander Hub / Velocity)](docs/portals-and-navigation.md)

## Building

```bash
mvn            # runs the defaultGoal: clean install
mvn clean verify
```

Every module's jar is collected into a single directory, **`agent/target/plugins/`**, ready to drop onto the servers:

```
agent/target/plugins/
  zander-velocity-<version>.jar   -> proxy
  zander-hub-<version>.jar        -> hub server
  zander-addon-<version>.jar      -> each game server
  zander-auth-<version>.jar       -> each game server
```

The collection step is an inherited `maven-antrun-plugin` execution in the
parent pom, bound to the **`verify`** phase. It must run after `package`,
because `maven-shade-plugin` binds to `package` and replaces each module's jar
with the shaded one — collecting earlier picks up the pre-shade jar, which is
missing its bundled dependencies and fails at runtime with
`NoClassDefFoundError`.

`mvn clean package` therefore does **not** populate `target/plugins/`; use
`verify` or `install` (or bare `mvn`, which is already `clean install`).

## Dashboard holograms

The `zander-addon` plugin fetches enabled message frames from the web dashboard
using the `hologram` API-key scope. Set `api-url` in each server's addon
`config.yml`. For least privilege, set `holograms.api-key` to a dedicated key
with the `hologram` scope; if it is blank, holograms reuse the shared `api-key`.
That shared key also needs the `bridge` scope while the addon's bridge features
are enabled. The plugin
polls `/api/hologram/messages` and renders matching frames in named groups, so
the same addon jar can be installed on any game server.

In the web dashboard, add one or more enabled frames under a group (for example
`default`). On the server where you want the hologram, stand at the desired
position and run
`/hologram create <name> <group>` (for example `/hologram create spawn default`).
The text appears above the player's position. Use `/hologram move <name>` to
move it to where you are standing, `/hologram list` to inspect placements, and
`/hologram delete <name>` to remove one. `/hologram reload` requests fresh web
content. Each server keeps its own placements in
`plugins/zander-addon/holograms.yml`. Existing placements are copied from the
local `zander-hub/holograms.yml` on first startup when present. Message content
stays in the dashboard. Right-clicking a hologram with a link
frame showing offers that URL in chat.

Hologram placement commands require `zanderaddon.hologram.admin` (operators by
default). Group names are case-insensitive and should match the dashboard group.
