/**
 * webstore_visibility action: show or hide one storefront product.
 * payload: { stripePriceId, mode: 'enable' | 'disable' }
 *
 * 'enable' makes the product visible on /webstore, 'disable' hides it. The use
 * it was built for is a timed launch: keep a "coming soon" product hidden, then
 * schedule an enable at its go-live moment (and optionally a later disable for a
 * seasonal item).
 *
 * Keyed by Stripe price id, the same handle the storefront and the dashboard
 * toggle use. setItemVisibility touches only the `visible` flag, so a product's
 * category (including a hand-set one) is left exactly as it was.
 */
import { setItemVisibility } from "../../../controllers/webstoreItemSettingsController.js";

export function validate(payload = {}) {
  const errors = [];
  if (!String(payload.stripePriceId ?? "").trim()) {
    errors.push("webstore_visibility: a stripePriceId is required.");
  }
  if (!["enable", "disable"].includes(payload.mode)) {
    errors.push("webstore_visibility: mode must be 'enable' or 'disable'.");
  }
  return errors;
}

export function describe(payload = {}) {
  const verb = payload.mode === "enable" ? "Show" : "Hide";
  return `${verb} webstore product ${payload.stripePriceId}`;
}

export function preview(payload = {}) {
  const visible = payload.mode === "enable";
  return {
    summary: describe(payload),
    sideEffects: [`Sets visible=${visible} on storefront product ${payload.stripePriceId}.`],
  };
}

export async function run(payload = {}) {
  const stripePriceId = String(payload.stripePriceId ?? "").trim();
  const visible = payload.mode === "enable";
  await setItemVisibility(stripePriceId, visible);
  return {
    status: "succeeded",
    message: `${visible ? "showed" : "hid"} webstore product ${stripePriceId}`,
    refs: { stripePriceId },
  };
}
