/**
 * admin/adminHelpers.js
 *
 * Shared utilities called from dashboard route handlers to populate the
 * common view-data that every admin layout partial expects.
 */

import { getMenuGroups } from "./pageRegistry.js";

/**
 * Build the base data object that every admin view needs alongside its own
 * page-specific data.  Spread this into your view() call:
 *
 *   const base = adminViewData(req, features);
 *   await app.view("dashboard/announcements/announcements-list", {
 *     ...base,
 *     pageTitle: "Announcements",
 *     config,
 *     features,
 *     req,
 *     apiData: rows,
 *   });
 *
 * @param {FastifyRequest} req       – Fastify request (needs req.session.user)
 * @param {object}         features  – parsed features.json object
 * @returns {{ adminMenuGroups: object[], adminCurrentPath: string }}
 */
export function adminViewData(req, features) {
  const userPermissions = req.session?.user?.permissions ?? [];
  return {
    adminMenuGroups: getMenuGroups(userPermissions, features),
    adminCurrentPath: req.url.split("?")[0],
  };
}
