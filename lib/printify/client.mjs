/**
 * lib/printify/client.mjs
 *
 * Thin client for the Printify v1 API, used by the Webstore module to fulfil
 * physical (print-on-demand) orders.
 *
 * Auth and config come from the environment:
 *   PRINTIFY_API_TOKEN — personal access token (Bearer). Scopes needed:
 *                        shops.read, orders.read, orders.write.
 *   PRINTIFY_SHOP_ID   — numeric shop id (see listShops()). Optional: when
 *                        unset, the first shop is used.
 *
 * Printify requires a User-Agent on every request and speaks JSON only.
 * All money amounts in requests/responses are integer cents.
 *
 * No DB import here, so this stays unit-testable. Errors throw a PrintifyError
 * carrying the HTTP status and response body so callers can decide whether a
 * failure is retryable (5xx / network) or terminal (4xx).
 */

import fetch from "node-fetch";

const PRINTIFY_BASE = "https://api.printify.com/v1";
const USER_AGENT = "Zander-Webstore (https://craftingforchrist.net)";
const DEFAULT_TIMEOUT_MS = 15_000;

export class PrintifyError extends Error {
  constructor(message, { status = 0, body = null, retryable = false } = {}) {
    super(message);
    this.name = "PrintifyError";
    this.status = status;
    this.body = body;
    this.retryable = retryable;
  }
}

function requireToken() {
  const token = process.env.PRINTIFY_API_TOKEN;
  if (!token) throw new PrintifyError("PRINTIFY_API_TOKEN is not configured", { retryable: false });
  return token;
}

/**
 * Low-level request helper. Throws PrintifyError on non-2xx or transport error.
 * 5xx and network failures are marked retryable; 4xx are terminal.
 */
async function printifyRequest(path, { method = "GET", body = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const token = requireToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(`${PRINTIFY_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json;charset=utf-8",
        Accept: "application/json",
      },
      body: body == null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    // Abort or network failure — always worth a retry.
    throw new PrintifyError(`Printify request failed: ${err.message}`, { retryable: true });
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!response.ok) {
    throw new PrintifyError(
      `Printify ${method} ${path} → ${response.status}`,
      { status: response.status, body: parsed, retryable: response.status >= 500 }
    );
  }

  return parsed;
}

/** True when a token is configured — lets callers skip Printify work cleanly. */
export function isPrintifyConfigured() {
  return Boolean(process.env.PRINTIFY_API_TOKEN);
}

/** GET /v1/shops.json → [{ id, title, sales_channel }] */
export async function listShops() {
  return printifyRequest("/shops.json");
}

/**
 * Resolve the shop id to operate on: PRINTIFY_SHOP_ID if set, else the first
 * shop on the account. Cached for the process lifetime once resolved.
 */
let resolvedShopId = null;
export async function getShopId() {
  if (process.env.PRINTIFY_SHOP_ID) return String(process.env.PRINTIFY_SHOP_ID);
  if (resolvedShopId) return resolvedShopId;
  const shops = await listShops();
  if (!Array.isArray(shops) || shops.length === 0) {
    throw new PrintifyError("No Printify shops available on this account", { retryable: false });
  }
  resolvedShopId = String(shops[0].id);
  return resolvedShopId;
}

/** For tests: forget the cached shop id. */
export function _resetShopIdCache() {
  resolvedShopId = null;
}

/**
 * GET products in the shop (paginated). Handy for the admin to find
 * product/variant ids. Returns the raw page object { data, current_page, ... }.
 */
export async function listProducts({ page = 1, limit = 50 } = {}) {
  const shopId = await getShopId();
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  return printifyRequest(`/shops/${shopId}/products.json?${params}`);
}

/**
 * Build a Printify address_to object from our checkout snapshot.
 * Only the fields Printify recognises are included.
 */
export function toPrintifyAddress(addr) {
  return {
    first_name: addr.firstName || "",
    last_name: addr.lastName || "",
    email: addr.email || "",
    phone: addr.phone || "",
    country: (addr.country || "").toUpperCase(),
    region: addr.region || "",
    address1: addr.address1 || "",
    address2: addr.address2 || "",
    city: addr.city || "",
    zip: addr.zip || "",
  };
}

/**
 * POST /v1/shops/{shop}/orders/shipping.json — calculate shipping for an order.
 *
 * @param {Array<{product_id:string,variant_id:number,quantity:number}>} lineItems
 * @param {object} address — our snapshot shape (see toPrintifyAddress)
 * @returns {Promise<{standard?:number, express?:number, priority?:number,
 *                    economy?:number, printify_express?:number}>} cents
 */
export async function calculateShipping(lineItems, address) {
  const shopId = await getShopId();
  return printifyRequest(`/shops/${shopId}/orders/shipping.json`, {
    method: "POST",
    body: { line_items: lineItems, address_to: toPrintifyAddress(address) },
  });
}

/**
 * Shipping method codes Printify accepts on an order.
 * 1 = standard, 2 = priority, 3 = express, 4 = economy.
 */
export const SHIPPING_METHOD = { STANDARD: 1, PRIORITY: 2, EXPRESS: 3, ECONOMY: 4 };

/**
 * POST /v1/shops/{shop}/orders.json — create an order.
 *
 * external_id makes this idempotent: reusing one returns Printify's 409
 * conflict, which the caller treats as "already created".
 *
 * @returns {Promise<{id:string, ...}>} the created order
 */
export async function createOrder({
  externalId,
  label = null,
  lineItems,
  address,
  shippingMethod = SHIPPING_METHOD.STANDARD,
  sendShippingNotification = true,
}) {
  const shopId = await getShopId();
  const body = {
    external_id: externalId,
    line_items: lineItems,
    shipping_method: shippingMethod,
    send_shipping_notification: sendShippingNotification,
    address_to: toPrintifyAddress(address),
  };
  if (label) body.label = label;
  return printifyRequest(`/shops/${shopId}/orders.json`, { method: "POST", body });
}

/**
 * POST /v1/shops/{shop}/orders/{order}/send_to_production.json
 * Charges the connected Printify payment method and queues production.
 */
export async function sendToProduction(orderId) {
  const shopId = await getShopId();
  return printifyRequest(
    `/shops/${shopId}/orders/${encodeURIComponent(orderId)}/send_to_production.json`,
    { method: "POST" }
  );
}

/** GET a single order (for status / tracking). */
export async function getOrder(orderId) {
  const shopId = await getShopId();
  return printifyRequest(`/shops/${shopId}/orders/${encodeURIComponent(orderId)}.json`);
}
