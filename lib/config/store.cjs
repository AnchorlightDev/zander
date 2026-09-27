/**
 * lib/config/store.cjs
 *
 * The one live settings object for the whole process.
 *
 * Every module gets `config` and `features` from here (config.cjs /
 * features.cjs), and Node caches the module, so they all hold the same two
 * objects. They start as the built-in defaults; at boot
 * controllers/configSettingsController.js loads the saved settings from the
 * database and writes them into these same objects, in place, so references a
 * module took at import time see the real values.
 */

const { DEFAULT_CONFIG, DEFAULT_FEATURES } = require("./defaults.cjs");

module.exports = {
  config: structuredClone(DEFAULT_CONFIG),
  features: structuredClone(DEFAULT_FEATURES),
};
