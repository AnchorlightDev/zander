import applicationRedirectRoute from "./application.js";
import serverRedirectRoute from "./server.js";
import webRedirectRoute from "./web.js";
import announcementsRedirectRoute from "./announcement.js";
import reportRedirectRoute from "./report.js";
import vaultRedirectRoute from "./vault.js";
import bridgeRedirectRoute from "./bridge.js";
import rankRedirectRoute from "./rank.js";
import schedulerRedirectRoute from "./scheduler.js";

export default (app, config, lang, features) => {
  applicationRedirectRoute(app, config, lang, features);
  serverRedirectRoute(app, config, lang, features);
  reportRedirectRoute(app, config, lang, features);
  webRedirectRoute(app, config, lang, features);
  announcementsRedirectRoute(app, config, lang, features);
  vaultRedirectRoute(app, config, lang, features);
  bridgeRedirectRoute(app, config, lang, features);
  rankRedirectRoute(app, config, lang, features);
  schedulerRedirectRoute(app, config, lang, features);
};
