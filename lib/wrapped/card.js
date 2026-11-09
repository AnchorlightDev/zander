/**
 * Server-rendered SVG summary card for a Wrapped run — one image that recaps
 * every slide. Pure (payload -> SVG string) so it's unit-testable and needs no
 * headless browser. The page rasterises this SVG to PNG in a canvas; keeping it
 * fully self-contained (logo + avatar passed in as data URIs) is what lets the
 * canvas export without tainting.
 */

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function dmy(dateish) {
  const d = new Date(dateish);
  if (Number.isNaN(d.getTime())) return String(dateish);
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${d.getUTCFullYear()} ${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function plural(n, w) {
  return `${n} ${w}${n === 1 ? "" : "s"}`;
}

/** Human "time elapsed since <date>" — e.g. "2 years, 9 months". */
function elapsedSince(dateish) {
  const d = new Date(dateish);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let years = now.getUTCFullYear() - d.getUTCFullYear();
  let months = now.getUTCMonth() - d.getUTCMonth();
  if (now.getUTCDate() - d.getUTCDate() < 0) months--;
  if (months < 0) { months += 12; years--; }
  if (years < 0) return "today";
  if (years >= 1) return plural(years, "year") + (months ? `, ${plural(months, "month")}` : "");
  if (months >= 1) return plural(months, "month");
  const days = Math.max(0, Math.round((now - d) / 86400000));
  return days >= 1 ? plural(days, "day") : "today";
}

function fmtSecs(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

const num = (n) => Number(n || 0).toLocaleString("en-US");

function prettyBlock(id) {
  return (
    String(id || "")
      .replace(/^minecraft:/, "")
      .split("_")
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ") || "a block"
  );
}

export const CARD_W = 1080;
export const CARD_H = 1920;

/**
 * Server-rendered summary card — a single 1080×1920 (Instagram-story / 9:16)
 * SVG that recaps the whole run in one compact list, matching the visual
 * language of the per-slide story cards (lib/wrapped/slideCard.js). Pure
 * (payload -> SVG string); the page rasterises it to PNG. Self-contained: logo
 * + avatar + background come in as data URIs so the canvas export never taints.
 *
 * @param {object} payload  the stored Wrapped payload (version 1)
 * @param {{ logoDataUri?: string|null, avatarDataUri?: string|null, backgroundDataUri?: string|null }} [assets]
 * @returns {string} SVG markup, 1080x1920
 */
export function renderWrappedCard(payload, assets = {}) {
  const p = payload || {};
  const s = p.stats || {};
  const mc = s.minecraft || {};
  const user = p.user || {};
  const year = p.period?.label || p.period?.year || "";
  const siteName = assets.siteName || "Crafting For Christ";
  const { logoDataUri = null, avatarDataUri = null, backgroundDataUri = null } = assets;
  const cx = CARD_W / 2;

  // Compact recap lines — every stat the run actually has, priority order.
  const lines = [];
  const push = (label, value) => {
    if (value === null || value === undefined || value === "") return;
    lines.push({ label, value: String(value) });
  };

  if (Number(s.playtime?.value) > 0) push("Playtime", s.playtime.display);
  if (Number(s.sessions?.value) > 0) push("Sessions", num(s.sessions.value));
  if (s.tenure?.firstSeen) {
    const ago = elapsedSince(s.tenure.firstSeen);
    push("Member for", ago ? `${ago} · since ${dmy(s.tenure.firstSeen)}` : dmy(s.tenure.firstSeen));
  }
  if (s.mostActiveDay?.date) push("Busiest day", `${dmy(s.mostActiveDay.date)} · ${fmtSecs(s.mostActiveDay.seconds)}`);
  if (Number(mc.blocksMined) > 0) push("Blocks mined", num(mc.blocksMined));
  if (mc.topBlock?.block) push("Favourite block", `${prettyBlock(mc.topBlock.block)} · ${num(mc.topBlock.count)}`);
  if (Number(mc.distanceCm) > 0) push("Distance", `${num(Math.round(mc.distanceCm / 100000))} km`);
  if (Number(mc.mobsKilled) > 0) push("Mobs killed", num(mc.mobsKilled));
  if (Number(mc.breadCrafted) > 0) push("Bread baked", num(mc.breadCrafted));
  if (Number(mc.fishCaught) > 0) push("Fish caught", num(mc.fishCaught));
  if (Number(s.shopPurchases?.value) > 0) {
    const ti = s.shopPurchases.topItem?.itemId ? ` · ${prettyBlock(s.shopPurchases.topItem.itemId)}` : "";
    push("Shop purchases", `${num(s.shopPurchases.value)}${ti}`);
  }
  if (Number(s.discordMessages?.value) > 0) push("Discord messages", num(s.discordMessages.value));
  if (Number(s.discordReactions?.value) > 0) push("Reactions given", num(s.discordReactions.value));
  if (Number(s.voiceMinutes?.value) > 0) push("Voice", s.voiceMinutes.display);
  if (s.reputation?.level != null) push("Reputation level", s.reputation.level);
  if (s.topCommand?.command) push("Top command", `/${String(s.topCommand.command).replace(/^\//, "")}`);
  if (s.friend?.name) push("Voice buddy", s.friend.name);
  if (s.ingameFriend?.name) push("In-game buddy", s.ingameFriend.name);

  const shown = lines.slice(0, 15);
  const listTop = 760;
  const rowH = 66;
  const rows = shown.length
    ? shown
        .map((line, i) => {
          const y = listTop + i * rowH;
          return `  <text x="80" y="${y}" class="k">${esc(line.label)}</text>
  <text x="${CARD_W - 80}" y="${y}" class="v" text-anchor="end">${esc(line.value)}</text>`;
        })
        .join("\n")
    : `  <text x="${cx}" y="900" text-anchor="middle" class="k">Not much logged for ${esc(year)} yet — check back soon.</text>`;

  const img = (uri, attrs) => `<image href="${esc(uri)}" xlink:href="${esc(uri)}" ${attrs}/>`;

  const bg = backgroundDataUri
    ? `<image href="${esc(backgroundDataUri)}" xlink:href="${esc(backgroundDataUri)}" x="0" y="0" width="${CARD_W}" height="${CARD_H}" preserveAspectRatio="xMidYMid slice" opacity="0.35"/>
  <rect width="${CARD_W}" height="${CARD_H}" fill="#060a1f" opacity="0.55"/>`
    : "";

  const logo = logoDataUri
    ? img(logoDataUri, `x="${cx - 160}" y="96" width="320" height="150" preserveAspectRatio="xMidYMid meet"`)
    : "";

  const avatar = avatarDataUri
    ? `<clipPath id="avclip"><rect x="${cx - 120}" y="286" width="240" height="240" rx="28"/></clipPath>
  ${img(avatarDataUri, `x="${cx - 120}" y="286" width="240" height="240" clip-path="url(#avclip)" preserveAspectRatio="xMidYMid slice"`)}`
    : "";

  const vibe = p.vibe?.label ? esc(p.vibe.label) : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}" role="img">
  <defs>
    <radialGradient id="bg" cx="50%" cy="30%" r="85%">
      <stop offset="0%" stop-color="#1a2350" stop-opacity="0.55"/>
      <stop offset="60%" stop-color="#060a1f" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="#060a1f"/>
    </radialGradient>
  </defs>
  <style>
    text{font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;fill:#fff}
    .brand{font-size:34px;fill:#b9a7ff;letter-spacing:6px}
    .name{font-size:88px;font-weight:800}
    .year{font-size:38px;fill:#c9d4ff}
    .k{font-size:34px;fill:#aeb9de}
    .v{font-size:36px;font-weight:700}
    .vibe{font-size:46px;font-weight:800;fill:#ffd479}
    .foot{font-size:30px;fill:#8a95bd;letter-spacing:1px}
  </style>
  <rect width="${CARD_W}" height="${CARD_H}" fill="#060a1f"/>
  ${bg}
  <rect width="${CARD_W}" height="${CARD_H}" fill="url(#bg)"/>
  ${logo}
  ${avatar}
  <text x="${cx}" y="600" text-anchor="middle" class="brand">${esc(siteName.toUpperCase())} · WRAPPED ${esc(year)}</text>
  <text x="${cx}" y="690" text-anchor="middle" class="name">${esc(user.username || "Player")}</text>
  <text x="${cx}" y="738" text-anchor="middle" class="year">Your year on the server</text>
${rows}
  ${vibe ? `<text x="${cx}" y="1820" text-anchor="middle" class="vibe">“${vibe}”</text>` : ""}
  <text x="${cx}" y="1880" text-anchor="middle" class="foot">${esc(siteName)} · Wrapped ${esc(year)}</text>
</svg>`;
}
