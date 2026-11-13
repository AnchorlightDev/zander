// A blank platform URL would send an empty Location (a redirect loop back to
// the same path), so only follow a real http(s) URL and 404 otherwise.
export function platformRedirectTarget(value) {
  const url = typeof value === "string" ? value.trim() : "";
  return /^https?:\/\/\S+$/i.test(url) ? url : null;
}

export default function redirectSiteRoutes(app, config, featuress) {
  const redirectToPlatform = (key) => async function (req, res) {
    const target = platformRedirectTarget(config.siteConfiguration?.platforms?.[key]);
    if (!target) return res.callNotFound();
    return res.redirect(target);
  };

  //
  // Discord Redirect
  //
  app.get("/discord", redirectToPlatform("discord"));

  //
  // Guides Redirect
  //
  app.get("/knowledgebase", redirectToPlatform("knowledgebase"));

  //
  // Issue Tracker Redirect
  //
  app.get("/issues", redirectToPlatform("issueTracker"));
}
