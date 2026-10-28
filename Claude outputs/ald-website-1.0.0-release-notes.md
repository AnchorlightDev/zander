The first versioned release of [anchorlight.dev](https://anchorlight.dev): the Anchorlight product catalogue and documentation centre.

## What's on the site

- **Product catalogue:** every Anchorlight product, grouped by category, with its status (available, beta or in development), features, documentation and release links.
- **Documentation centre:** guides for 12 products: Ascendra, Blueprint, ConsentPVP, Craftify, DevoteMe, EdenEffects, MineMail, QuestKeeper, RallyPoint, StoneLib, Traverse and Zander.
- **About and contact pages**, built around Anchorlight's vision, values and mission.

## New in this release: Zander docs for 2.2.0

The Zander documentation has been brought fully up to date with Zander 2.2.0 and is now the single home for Zander's docs:

- **[Upgrading to 2.2.0](https://anchorlight.dev/docs/products/zander/upgrading):** the steps that matter before you deploy.
- **Rewritten setup pages:** installation, configuration, permissions and administration now match how Zander works today, with settings in the dashboard and a separate API key for each server.
- **New feature pages:** [holograms](https://anchorlight.dev/docs/products/zander/features/holograms), [pages and menus](https://anchorlight.dev/docs/products/zander/features/pages-and-menus), [resources](https://anchorlight.dev/docs/products/zander/features/resources), [Compass sign-in](https://anchorlight.dev/docs/products/zander/features/compass-sso) and the [webstore](https://anchorlight.dev/docs/products/zander/features/webstore).
- **Interactive API reference** regenerated: removed endpoints are gone, new ones are documented, and every endpoint shows the API key scope it needs.

Also updated: MineMail 1.2.0, RallyPoint 1.1.0 and EdenEffects documentation.

## For contributors

- `npm ci` works again; the lockfile was out of sync.
- The README now explains how the site is deployed (automatically from `main`) and released.

**Full changelog:** [CHANGELOG.md](https://github.com/AnchorlightDev/website/blob/main/CHANGELOG.md)
