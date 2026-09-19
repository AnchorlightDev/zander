import ejs from "ejs";
import path from "path";
import { createRequire } from "module";
const require = createRequire("file:///C:/Users/Ben/Documents/GitHub/zander/x.js");
const config = require("C:/Users/Ben/Documents/GitHub/zander/config.json");
const features = require("C:/Users/Ben/Documents/GitHub/zander/features.json");
const root = "C:/Users/Ben/Documents/GitHub/zander/views";

const req = { session: { user: { userId: 1, username: "ben", permissions: ["*"], ranks: [], isStaff: true, profilePicture: "" } }, url: "/dashboard/events/create", headers: {} };

const locals = {
  pageTitle: "Dashboard - Create Event",
  selectableRanks: [
    { rankSlug: "supporter", displayName: "Supporter", isDonator: true, isStaff: false, priority: 10 },
    { rankSlug: "admin", displayName: "Admin", isDonator: false, isStaff: true, priority: 100 },
  ],
  config, features, req,
  mode: "create",
  ev: {},
  isPublished: false,
  apiEndpoint: "/api/events/create",
  templatesData: { data: [] },
  globalImage: "",
  announcementWeb: null,
};

try {
  const html = await ejs.renderFile(path.join(root, "dashboard/events/events-editor.ejs"), locals, { root, views: [root], async: true });
  console.log("RENDER OK, length:", html.length);
} catch (e) {
  console.log("RENDER FAILED:");
  console.log(e.message);
  if (e.path) console.log("in:", e.path);
}
