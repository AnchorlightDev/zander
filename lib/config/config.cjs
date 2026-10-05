/**
 * lib/config/config.cjs
 *
 * `const config = require("../lib/config/config.cjs");` -- the live site
 * settings object (defaults + what is saved at /dashboard/settings).
 * Read values at use time (`config.x.y`) rather than copying them at import.
 */
module.exports = require("./store.cjs").config;
