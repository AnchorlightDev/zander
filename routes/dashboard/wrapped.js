/**
 * routes/dashboard/wrapped.js
 *
 * Admin UI for Crafting For Christ Wrapped:
 *   - set the period start/end and the on/off switch (persisted in
 *     wrappedSettings; overrides config.json)
 *   - preview your own or any user's Wrapped without persisting a run
 *
 * Rendered under /dashboard/wrapped/* so it reuses the shared admin chrome.
 */

import { hasPermission } from "../../api/common.js";
import { adminViewData } from "../../admin/adminHelpers.js";
import { getWebAnnouncement } from "../../controllers/announcementController.js";
import { UserGetter } from "../../controllers/userController.js";
import db from "../../controllers/databaseController.js";
import {
  getWrappedSettings,
  saveWrappedSettings,
  setWrappedMusicUrl,
  listWrappedRuns,
  getUserProfileRow,
} from "../../controllers/wrappedController.js";
import { isCloudinaryConfigured, uploadAudio } from "../../services/cloudinaryService.js";
import { checkRateLimit } from "../../lib/rateLimiter.mjs";
import {
  getConfiguredWrappedPeriod,
  buildWrappedPreview,
  resolveWrappedPeriod,
  getOrBuildWrapped,
  rebuildWrappedLeaderboard,
} from "../../services/wrapped/wrappedService.js";
import { renderWrappedCard } from "../../lib/wrapped/card.js";
import { buildWrappedSlides } from "../../lib/wrapped/slides.js";
import { buildDemoWrappedPayload } from "../../lib/wrapped/demoPayload.js";
import { renderWrappedSlideCard } from "../../lib/wrapped/slideCard.js";
import { diagnoseMineMonitor } from "../../services/wrapped/minemonitorClient.js";
import {
  pickGlobalBackground,
  pickGlobalBackgrounds,
  musicUrl,
  logoDataUri,
  avatarDataUri,
  resolveAvatarUrl,
  globalBackgroundDataUri,
} from "../../lib/wrapped/pageAssets.js";

import moment from "moment";

async function previewAvatarUrl(payloadUser) {
  const row = (await getUserProfileRow(payloadUser?.userId)) || {
    uuid: payloadUser?.uuid,
    username: payloadUser?.username,
  };
  return resolveAvatarUrl(row);
}

const CAP = "zander.web.wrapped";
const MMDD = /^\d{2}-\d{2}$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v) => MMDD.test(v) || YMD.test(v);

const MAX_MUSIC_BYTES = 8 * 1024 * 1024; // 8 MB, matching @fastify/multipart limits

/**
 * Sniff the leading bytes so a renamed file can't be stored as audio. Covers
 * MP3 (ID3 tag or MPEG frame sync), OGG, WAV, and MP4/M4A/AAC containers.
 */
function looksLikeAudio(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf.toString("ascii", 0, 3) === "ID3") return true; // MP3 with ID3 tag
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true; // MPEG/AAC frame sync
  if (buf.toString("ascii", 0, 4) === "OggS") return true; // OGG
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE") return true; // WAV
  if (buf.toString("ascii", 4, 8) === "ftyp") return true; // MP4 / M4A
  return false;
}

/** Accept only http(s) URLs for a pasted track link. */
function isHttpUrl(v) {
  try {
    const u = new URL(String(v));
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export default function dashboardWrappedRoute(app, config, features, lang) {
  async function shell(req, view, extra) {
    return app.view(view, {
      config,
      features,
      req,
      moment,
      announcementWeb: await getWebAnnouncement(),
      ...adminViewData(req, features),
      ...extra,
    });
  }
  const send = (res, html) =>
    res.header("content-type", "text/html; charset=utf-8").send(html);

  async function resolveUser(username) {
    if (!username) return null;
    const row = await new UserGetter().byUsername(String(username).trim());
    if (!row) return null;
    return { userId: row.userId, username: row.username, uuid: row.uuid };
  }

  const periodSummary = (p) => ({
    label: p.label,
    start: new Date(p.start).toISOString(),
    end: new Date(p.end).toISOString(),
    enabled: p.enabled,
  });

  // ── Player autocomplete for the preview field ─────────────────────────
  app.get("/dashboard/wrapped/user-search", async (req, res) => {
    if (!(await hasPermission(CAP, req, res, features))) return;

    const term = (req.query.q || "").trim();
    if (term.length < 2) return res.send({ results: [] });

    try {
      const rows = await new Promise((resolve, reject) => {
        db.query(
          `SELECT userId, username, uuid, profilePicture_type, profilePicture_email
             FROM users WHERE username LIKE ? ORDER BY username ASC LIMIT 8`,
          [`${term}%`],
          (err, results) => (err ? reject(err) : resolve(results || []))
        );
      });
      const results = await Promise.all(
        rows.map(async (row) => ({
          userId: row.userId,
          username: row.username,
          avatarUrl: await resolveAvatarUrl(row),
        }))
      );
      return res.send({ results });
    } catch (error) {
      console.error("[dashboard/wrapped] user-search error:", error);
      if (!res.sent) return res.status(500).send({ results: [] });
    }
  });

  // ── MineMonitor connectivity probe ───────────────────────────────────
  app.get("/dashboard/wrapped/minemonitor-test", async (req, res) => {
    if (!(await hasPermission(CAP, req, res, features))) return;
    const user = await resolveUser(req.query.username);
    const period = await getConfiguredWrappedPeriod();
    if (!user) {
      return res.send({ error: "Unknown username", period: periodSummary(period) });
    }
    const result = await diagnoseMineMonitor(
      user.uuid || null,
      new Date(period.start),
      new Date(period.end)
    );
    return res.send({
      username: user.username,
      uuid: user.uuid || null,
      period: periodSummary(period),
      ...result,
    });
  });

  // ── Settings + preview launcher ────────────────────────────────────────
  app.get("/dashboard/wrapped", async (req, res) => {
    if (!(await hasPermission(CAP, req, res, features))) return;

    const [settings, period] = await Promise.all([
      getWrappedSettings(),
      getConfiguredWrappedPeriod(),
    ]);
    const runs = await listWrappedRuns(period.year, 30);
    const stash = req.session?.wrappedPreview;

    return send(
      res,
      await shell(req, "dashboard/wrapped/index", {
        pageTitle: "Wrapped",
        settings,
        period,
        runs,
        saved: req.query.saved === "1",
        error: req.query.error || null,
        me: req.session?.user?.username || "",
        preview: stash?.payload
          ? {
              username: stash.username || "preview",
              demo: Boolean(stash.payload.demo),
              // one link per slide so the per-slide story cards can be eyeballed
              slides: buildWrappedSlides(stash.payload).map((s) => s.key),
            }
          : null,
      })
    );
  });

  // ── Demo preview: a fully-populated fake payload, no MineMonitor needed ──
  app.post("/dashboard/wrapped/demo", async (req, res) => {
    if (!(await hasPermission(CAP, req, res, features))) return;
    let period;
    const ps = String((req.body || {}).previewStart || "").trim();
    const pe = String((req.body || {}).previewEnd || "").trim();
    if (ps && pe && isDate(ps) && isDate(pe)) {
      period = resolveWrappedPeriod(new Date(), { enabled: true, periodStart: ps, periodEnd: pe });
    }
    const payload = buildDemoWrappedPayload({
      siteName: config?.siteConfiguration?.siteName || "Crafting For Christ",
      username: req.session?.user?.username || "DemoPlayer",
      period: period || (await getConfiguredWrappedPeriod()),
    });
    req.session.wrappedPreview = { payload, at: Date.now(), username: `${payload.user.username} (demo)` };
    return res.redirect("/dashboard/wrapped/preview");
  });

  app.post("/dashboard/wrapped/settings", async (req, res) => {
    if (!(await hasPermission(CAP, req, res, features))) return;

    const b = req.body || {};
    const periodStart = String(b.periodStart || "").trim();
    const periodEnd = String(b.periodEnd || "").trim();
    if ((periodStart && !isDate(periodStart)) || (periodEnd && !isDate(periodEnd))) {
      return res.redirect("/dashboard/wrapped?error=Dates+must+be+MM-DD+or+YYYY-MM-DD");
    }
    const rmRaw = String(b.rollingMonths || "").trim();
    if (rmRaw && !/^\d{1,2}$/.test(rmRaw)) {
      return res.redirect("/dashboard/wrapped?error=Rolling+months+must+be+a+number");
    }

    await saveWrappedSettings({
      enabled: b.enabled === "on" || b.enabled === "1" || b.enabled === "true",
      periodStart: periodStart || null,
      periodEnd: periodEnd || null,
      rollingMonths: rmRaw ? Number(rmRaw) : null,
    });
    return res.redirect("/dashboard/wrapped?saved=1");
  });

  // ── Music bed: upload a (no-copyright) track that plays over the deck ────
  // Stored on Cloudinary (persists across deploys, unlike the server disk) and
  // its URL kept in wrappedSettings. The deck falls back to the on-disk file
  // and then to the browser's generative bed when no track is set.
  app.post("/dashboard/wrapped/music", async (req, res) => {
    if (!(await hasPermission(CAP, req, res, features))) return;
    if (!checkRateLimit(req, res, { windowMs: 60_000, max: 10 })) return;

    if (!isCloudinaryConfigured()) {
      return res.redirect("/dashboard/wrapped?error=Audio+uploads+are+not+configured+(Cloudinary)");
    }

    let data;
    try {
      data = await req.file();
    } catch {
      data = null;
    }
    if (!data || !data.file) {
      return res.redirect("/dashboard/wrapped?error=No+file+provided");
    }

    const mimeOk = typeof data.mimetype === "string" && data.mimetype.startsWith("audio/");

    try {
      const chunks = [];
      let total = 0;
      for await (const chunk of data.file) {
        total += chunk.length;
        if (total > MAX_MUSIC_BYTES) {
          data.file.resume();
          return res.redirect("/dashboard/wrapped?error=File+too+large+(max+8+MB)");
        }
        chunks.push(chunk);
      }
      if (data.file.truncated) {
        return res.redirect("/dashboard/wrapped?error=File+too+large+(max+8+MB)");
      }
      const buffer = Buffer.concat(chunks);

      if (!mimeOk && !looksLikeAudio(buffer)) {
        return res.redirect("/dashboard/wrapped?error=That+file+does+not+look+like+audio+(mp3/ogg/wav/m4a)");
      }

      const result = await uploadAudio(buffer, { folder: "zander/wrapped" });
      await setWrappedMusicUrl(result.url);
      return res.redirect("/dashboard/wrapped?saved=1");
    } catch (err) {
      if (err?.code === "FST_REQ_FILE_TOO_LARGE") {
        return res.redirect("/dashboard/wrapped?error=File+too+large+(max+8+MB)");
      }
      req.log?.error?.({ err }, "[WRAPPED] music upload failed");
      return res.redirect("/dashboard/wrapped?error=Music+upload+failed");
    }
  });

  // Point the deck at an externally hosted track instead of uploading one.
  app.post("/dashboard/wrapped/music/url", async (req, res) => {
    if (!(await hasPermission(CAP, req, res, features))) return;
    const url = String((req.body || {}).musicUrl || "").trim();
    if (!isHttpUrl(url)) {
      return res.redirect("/dashboard/wrapped?error=Enter+a+valid+http(s)+audio+URL");
    }
    await setWrappedMusicUrl(url);
    return res.redirect("/dashboard/wrapped?saved=1");
  });

  // Clear the custom track; the deck reverts to the generative bed.
  app.post("/dashboard/wrapped/music/remove", async (req, res) => {
    if (!(await hasPermission(CAP, req, res, features))) return;
    await setWrappedMusicUrl(null);
    return res.redirect("/dashboard/wrapped?saved=1");
  });

  // ── Preview (no persistence) ──────────────────────────────────────────
  app.post("/dashboard/wrapped/preview", async (req, res) => {
    if (!(await hasPermission(CAP, req, res, features))) return;

    const b = req.body || {};
    const user = await resolveUser(b.username);
    if (!user) return res.redirect("/dashboard/wrapped?error=Unknown+username");

    // Optional per-preview window override.
    let period;
    const ps = String(b.previewStart || "").trim();
    const pe = String(b.previewEnd || "").trim();
    if (ps && pe && isDate(ps) && isDate(pe)) {
      period = resolveWrappedPeriod(new Date(), { enabled: true, periodStart: ps, periodEnd: pe });
    }

    try {
      const rebuildLeaderboard = b.refreshLeaderboard === "on" || b.refreshLeaderboard === "1";
      const payload = await buildWrappedPreview(user, { period, rebuildLeaderboard });
      req.session.wrappedPreview = { payload, at: Date.now(), username: user.username };
      return res.redirect("/dashboard/wrapped/preview");
    } catch (err) {
      req.log?.error?.({ err }, "[WRAPPED] admin preview failed");
      return res.redirect("/dashboard/wrapped?error=Preview+build+failed");
    }
  });

  // Force-regenerate a user's saved run (overwrites the frozen payload) and
  // refresh the MineMonitor-backed rank cache first.
  app.post("/dashboard/wrapped/regenerate", async (req, res) => {
    if (!(await hasPermission(CAP, req, res, features))) return;
    const user = await resolveUser((req.body || {}).username);
    if (!user) return res.redirect("/dashboard/wrapped?error=Unknown+username");
    try {
      await getOrBuildWrapped(user, { force: true });
      return res.redirect("/dashboard/wrapped?saved=1");
    } catch (err) {
      req.log?.error?.({ err }, "[WRAPPED] regenerate failed");
      return res.redirect("/dashboard/wrapped?error=Regenerate+failed");
    }
  });

  // Rebuild just the leaderboard/rank cache from MineMonitor for this period.
  app.post("/dashboard/wrapped/rebuild-leaderboard", async (req, res) => {
    if (!(await hasPermission(CAP, req, res, features))) return;
    try {
      await rebuildWrappedLeaderboard();
      return res.redirect("/dashboard/wrapped?saved=1");
    } catch (err) {
      req.log?.error?.({ err }, "[WRAPPED] leaderboard rebuild failed");
      return res.redirect("/dashboard/wrapped?error=Leaderboard+rebuild+failed");
    }
  });

  app.get("/dashboard/wrapped/preview", async (req, res) => {
    if (!(await hasPermission(CAP, req, res, features))) return;
    const stash = req.session?.wrappedPreview;
    if (!stash?.payload) return res.redirect("/dashboard/wrapped?error=Run+a+preview+first");

    const trackUrl = (await getWrappedSettings()).musicUrl;
    return send(
      res,
      await app.view("wrapped/show", {
        payload: stash.payload,
        payloadJson: JSON.stringify(stash.payload),
        slidesJson: JSON.stringify(buildWrappedSlides(stash.payload)),
        shared: true,
        preview: true,
        shareUrl: null,
        cardUrl: "/dashboard/wrapped/preview/card.svg",
        cardBase: "/dashboard/wrapped/preview/card",
        bgImage: pickGlobalBackground(),
        bgImages: pickGlobalBackgrounds(24),
        musicUrl: musicUrl(trackUrl),
        avatarUrl: await previewAvatarUrl(stash.payload?.user),
        siteName: config?.siteConfiguration?.siteName || "Crafting For Christ",
      })
    );
  });

  app.get("/dashboard/wrapped/preview/card.svg", async (req, res) => {
    if (!(await hasPermission(CAP, req, res, features))) return;
    const stash = req.session?.wrappedPreview;
    if (!stash?.payload) return res.status(404).send("no preview");
    const avatar = await avatarDataUri(await previewAvatarUrl(stash.payload?.user));
    return res
      .header("content-type", "image/svg+xml; charset=utf-8")
      .send(
        renderWrappedCard(stash.payload, {
          siteName: config?.siteConfiguration?.siteName || "Crafting For Christ",
          logoDataUri: logoDataUri(),
          avatarDataUri: avatar,
          backgroundDataUri: globalBackgroundDataUri(),
        })
      );
  });

  app.get("/dashboard/wrapped/preview/card/s/:slide.svg", async (req, res) => {
    if (!(await hasPermission(CAP, req, res, features))) return;
    const stash = req.session?.wrappedPreview;
    if (!stash?.payload) return res.status(404).send("no preview");
    const slide = buildWrappedSlides(stash.payload).find((x) => x.key === req.params.slide);
    if (!slide) return res.status(404).send("no such slide");
    const avatar = await avatarDataUri(await previewAvatarUrl(stash.payload?.user));
    return res.header("content-type", "image/svg+xml; charset=utf-8").send(
      renderWrappedSlideCard(slide, {
        user: stash.payload?.user,
        period: stash.payload?.period,
        siteName: config?.siteConfiguration?.siteName || "Crafting For Christ",
        logoDataUri: logoDataUri(),
        avatarDataUri: avatar,
        backgroundDataUri: globalBackgroundDataUri(),
      })
    );
  });
}
