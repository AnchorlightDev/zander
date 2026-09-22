/**
 * lib/connectionDetails.mjs
 *
 * The one place that turns `config.connection` into something a page can show.
 *
 * Imports nothing, so it is unit-testable without a config file or a server.
 * The values live in config.json precisely so they cannot drift between /play,
 * /ranks, /vault and the Bedrock page -- a Bedrock player following the wrong
 * port simply fails to connect, and there is no error message that explains
 * why. Read from here rather than writing an address into a template.
 *
 * Nothing about this module is Crafting For Christ specific. An operator sets
 * their own hosts and ports and every surface follows.
 */

/** Ports are 1-65535; anything else is treated as "no port configured". */
function normalisePort(raw) {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

function normaliseHost(raw) {
  return String(raw ?? "").trim().toLowerCase() || null;
}

/**
 * One edition's details.
 *
 * `address` is what a player types into their client. Java servers are almost
 * always reached on the default port and conventionally written without it,
 * so a null port renders as the bare host; Bedrock clients ask for host and
 * port in separate fields, so both are kept separately as well.
 */
function edition(raw) {
  const host = normaliseHost(raw?.host);
  const port = normalisePort(raw?.port);

  return {
    host,
    port,
    configured: Boolean(host),
    address: host ? (port ? `${host}:${port}` : host) : null,
  };
}

/**
 * Connection details for both editions.
 *
 * Always returns the same shape, so a template never has to test whether the
 * config block exists -- an unconfigured edition comes back with
 * `configured: false` and the page can say so rather than printing "undefined".
 */
export function getConnectionDetails(config) {
  const connection = config?.connection ?? {};
  return {
    java: edition(connection.java),
    bedrock: edition(connection.bedrock),
  };
}

/** True when there is enough configured to tell someone how to connect. */
export function hasBedrockConnection(config) {
  return getConnectionDetails(config).bedrock.configured;
}
