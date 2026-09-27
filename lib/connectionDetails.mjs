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

/**
 * Hosts that mean "nobody has filled this in yet".
 *
 * RFC 2606 reserves example.com/net/org and the .test, .example, .invalid and
 * .localhost TLDs precisely so they can be used in documentation and never
 * resolve to anything real. config.json.example ships example.net hosts, and
 * `changeme` is the placeholder this repo already uses elsewhere.
 *
 * This matters more than it looks. Without it, a half-configured install
 * publishes its placeholder as a real server address -- on a page that is
 * indexed, with structured data asserting it -- and the only symptom is
 * players quietly failing to connect to a host that does not exist.
 */
const PLACEHOLDER_HOST =
  /(^|\.)example\.(com|net|org)$|\.(test|example|invalid|localhost)$|^changeme$|^(your|my)[.-]?(server|host|domain)/;

function normaliseHost(raw) {
  const host = String(raw ?? "").trim().toLowerCase();
  if (!host) return null;
  // Treated as unset rather than rejected: the page then says "not published
  // yet" and is marked noindex, which is the correct state for an install
  // nobody has configured.
  if (PLACEHOLDER_HOST.test(host)) return null;
  return host;
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
 * Split "host" or "host:port" into the { host, port } shape `edition` takes.
 * A bare IPv6 address has several colons and no port, so only a single
 * trailing ":digits" counts as a port.
 */
export function parseAddress(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const match = text.match(/^([^:\s]+):(\d{1,5})$/);
  return match ? { host: match[1], port: Number(match[2]) } : { host: text, port: null };
}

/**
 * Connection details taken from the servers dashboard, in `config.connection`
 * shape, so the address is entered once and every page follows.
 *
 * Java is the first public (EXTERNAL) server by position; Bedrock is the first
 * public server that has a Bedrock address. Either can be missing.
 */
export function connectionFromServers(servers) {
  const publicServers = (Array.isArray(servers) ? servers : [])
    .filter((s) => s && s.serverType === "EXTERNAL")
    .sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity));

  const java = publicServers.map((s) => parseAddress(s.serverConnectionAddress)).find(Boolean) || null;
  const bedrock = publicServers.map((s) => parseAddress(s.bedrockAddress)).find(Boolean) || null;
  return { java, bedrock };
}

/**
 * Connection details for both editions.
 *
 * Each edition comes from the servers dashboard when a server supplies it,
 * otherwise from `config.connection` (installs set up before servers carried
 * a Bedrock address keep working).
 *
 * Always returns the same shape, so a template never has to test whether the
 * config block exists -- an unconfigured edition comes back with
 * `configured: false` and the page can say so rather than printing "undefined".
 *
 * @param {object} config
 * @param {Array}  [servers]  Rows from the servers table, if the caller has them.
 */
export function getConnectionDetails(config, servers = null) {
  const connection = config?.connection ?? {};
  const fromServers = connectionFromServers(servers);
  const pick = (fromServer, fromConfig) => {
    const derived = edition(fromServer);
    return derived.configured ? derived : edition(fromConfig);
  };
  return {
    java: pick(fromServers.java, connection.java),
    bedrock: pick(fromServers.bedrock, connection.bedrock),
  };
}

/** True when there is enough configured to tell someone how to connect. */
export function hasBedrockConnection(config) {
  return getConnectionDetails(config).bedrock.configured;
}
