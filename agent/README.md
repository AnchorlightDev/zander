# Zander plugins

The Minecraft plugins for Zander: `zander-velocity`, `zander-hub`, `zander-auth` and `zander-addon`.

Documentation is on the documentation site:

- **[Minecraft plugins](https://anchorlight.dev/docs/products/zander/features/minecraft-plugins)** — what each plugin does, commands, configuration and chat formatting
- **[Holograms](https://anchorlight.dev/docs/products/zander/features/holograms)** — dashboard frames and `/hologram` placement
- **[Installation](https://anchorlight.dev/docs/products/zander/installation)** — building and installing the plugins
- **[Permissions](https://anchorlight.dev/docs/products/zander/permissions)** — in-game permission nodes

## Building

```bash
mvn            # clean install; jars are collected in agent/target/plugins/
```

`mvn clean package` does **not** fill `target/plugins/`: the collection step runs in `verify`, after `maven-shade-plugin` has replaced each jar with the shaded one. Use `verify`, `install` or plain `mvn`.
