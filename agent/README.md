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
