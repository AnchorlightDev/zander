/**
 * api/routes/commandBridge.js
 *
 * Compatibility shim for the zander-addon StoreCommandService ("command bridge"),
 * which polls POST /api/command-bridge/{claim,complete,fail} for per-player
 * reward commands. That server-side feature was never implemented here — reward
 * and webstore commands are delivered through the executor-task bridge
 * (/api/bridge/processor/*) instead — so an addon with command-bridge still
 * enabled hammers these paths. Without a matching route every call 404s into the
 * not-found handler and floods the logs with "Reply was already sent" warnings.
 *
 * These handlers answer cleanly so the addon simply sees "no pending commands"
 * and stays quiet, regardless of whether a given server has flipped its addon's
 * command-bridge.enabled to false yet. Returning the reply (not calling send and
 * then returning a value) keeps Fastify from logging a double-send.
 *
 * Safe to delete once every connected server runs an addon build with the
 * command bridge disabled (see agent/zander-addon .../ZanderAddonMain.java).
 */
export default function commandBridgeApiRoute(app) {
  // Always "no commands to run" — real delivery is via /api/bridge/processor/*.
  app.post("/api/command-bridge/claim", async (req, res) =>
    res.send({ success: true, commands: [] })
  );

  // Fire-and-forget acknowledgements from the addon; just accept them.
  app.post("/api/command-bridge/complete", async (req, res) =>
    res.send({ success: true })
  );

  app.post("/api/command-bridge/fail", async (req, res) =>
    res.send({ success: true })
  );
}
