/**
 * lib/config/features.cjs
 *
 * `const features = require("../lib/config/features.cjs");` -- the live module
 * switches (defaults + what is saved at /dashboard/modules).
 * Read values at use time (`features.x`) rather than copying them at import.
 */
module.exports = require("./store.cjs").features;
