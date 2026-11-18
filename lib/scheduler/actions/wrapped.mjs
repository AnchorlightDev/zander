/** Toggle Wrapped availability using the existing scheduled-job runner. */
import { setWrappedEnabled } from "../../../controllers/wrappedController.js";

export function validate(payload = {}) {
  return ["enable", "disable"].includes(payload.mode)
    ? [] : ["wrapped: mode must be 'enable' or 'disable'."];
}

export function describe(payload = {}) {
  return `${payload.mode === "enable" ? "Enable" : "Disable"} CFC Wrapped`;
}

export function preview(payload = {}) {
  return {
    summary: describe(payload),
    sideEffects: ["Changes Wrapped availability. Reporting dates, music and saved recaps stay unchanged; existing public share links remain accessible."],
  };
}

export async function run(payload = {}) {
  const errors = validate(payload);
  if (errors.length) throw new Error(errors.join(" "));
  await setWrappedEnabled(payload.mode === "enable");
  return { status: "succeeded", message: `${payload.mode === "enable" ? "Enabled" : "Disabled"} CFC Wrapped` };
}
