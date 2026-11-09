/**
 * Server-rendered per-slide share card — a single 1080×1920 (Instagram-story /
 * 9:16) SVG for one Wrapped slide, so any slide of the deck can be saved and
 * dropped into Discord / socials. Pure (descriptor -> SVG string); the page
 * rasterises it to PNG in a canvas. Self-contained: logo + avatar come in as
 * data URIs so the canvas export never taints.
 *
 * Consumes the descriptors from lib/wrapped/slides.js, so the card always
 * matches what the live deck shows.
 */

export const SLIDE_CARD_W = 1080;
export const SLIDE_CARD_H = 1920;

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Naive width-unaware word wrap — good enough for a poster-style card. */
function wrap(str, maxChars) {
  const words = String(str ?? "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const w of words) {
    if (line && (line + " " + w).length > maxChars) {
      lines.push(line);
      line = w;
    } else {
      line = line ? line + " " + w : w;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

function tspans(lines, x, lineHeight) {
  return lines
    .map((l, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : lineHeight}">${esc(l)}</tspan>`)
    .join("");
}

const MOOD_TINT = {
  rise: "#143d6b",
  pop: "#3a1d6b",
  fanfare: "#6b4a12",
  drum: "#10403a",
  chime: "#1a2350",
};

function frame(mood, inner, backgroundDataUri) {
  const tint = MOOD_TINT[mood] || MOOD_TINT.chime;
  const bg = backgroundDataUri
    ? `<image href="${esc(backgroundDataUri)}" xlink:href="${esc(backgroundDataUri)}" x="0" y="0" width="${SLIDE_CARD_W}" height="${SLIDE_CARD_H}" preserveAspectRatio="xMidYMid slice" opacity="0.4"/>
  <rect width="${SLIDE_CARD_W}" height="${SLIDE_CARD_H}" fill="#060a1f" opacity="0.5"/>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${SLIDE_CARD_W}" height="${SLIDE_CARD_H}" viewBox="0 0 ${SLIDE_CARD_W} ${SLIDE_CARD_H}" font-family="'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <defs>
    <radialGradient id="g" cx="50%" cy="34%" r="80%">
      <stop offset="0%" stop-color="${tint}" stop-opacity="0.55"/>
      <stop offset="60%" stop-color="#060a1f" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="#060a1f"/>
    </radialGradient>
  </defs>
  <rect width="${SLIDE_CARD_W}" height="${SLIDE_CARD_H}" fill="#060a1f"/>
  ${bg}
  <rect width="${SLIDE_CARD_W}" height="${SLIDE_CARD_H}" fill="url(#g)"/>
  ${inner}
</svg>`;
}

function footer(siteName, label) {
  return `<text x="${SLIDE_CARD_W / 2}" y="${SLIDE_CARD_H - 90}" text-anchor="middle" fill="#8a95bd" font-size="30" letter-spacing="1">${esc(siteName)} · Wrapped ${esc(label)}</text>`;
}

function logoTag(logoDataUri) {
  if (!logoDataUri) return "";
  const w = 320;
  return `<image href="${logoDataUri}" xlink:href="${logoDataUri}" x="${(SLIDE_CARD_W - w) / 2}" y="150" width="${w}" height="150" preserveAspectRatio="xMidYMid meet"/>`;
}

/**
 * @param {object} slide  a descriptor from buildWrappedSlides()
 * @param {{ user?: object, period?: object, siteName?: string,
 *           logoDataUri?: string|null, avatarDataUri?: string|null }} ctx
 * @returns {string} SVG
 */
export function renderWrappedSlideCard(slide, ctx = {}) {
  const sl = slide || {};
  const cx = SLIDE_CARD_W / 2;
  const siteName = ctx.siteName || "Crafting For Christ";
  const label = (ctx.period && ctx.period.label) || (sl && sl.period) || "";
  const username = (ctx.user && ctx.user.username) || "";
  const parts = [logoTag(ctx.logoDataUri)];

  if (sl.kind === "title") {
    if (ctx.avatarDataUri) {
      const a = 300;
      parts.push(
        `<clipPath id="av"><rect x="${cx - a / 2}" y="470" width="${a}" height="${a}" rx="36"/></clipPath>`,
        `<image href="${ctx.avatarDataUri}" xlink:href="${ctx.avatarDataUri}" x="${cx - a / 2}" y="470" width="${a}" height="${a}" clip-path="url(#av)" preserveAspectRatio="xMidYMid slice"/>`
      );
    }
    parts.push(
      `<text x="${cx}" y="880" text-anchor="middle" fill="#b9a7ff" font-size="34" letter-spacing="7">${esc(siteName.toUpperCase())} · WRAPPED</text>`,
      `<text x="${cx}" y="1000" text-anchor="middle" fill="#ffffff" font-size="104" font-weight="800">${esc(username)}</text>`,
      `<text x="${cx}" y="1110" text-anchor="middle" fill="#c9d4ff" font-size="42">Here's your ${esc(label)} on the server.</text>`
    );
  } else if (sl.kind === "board") {
    const nb = sl.neighbors || { rows: [], rank: 0, total: 0 };
    parts.push(
      `<text x="${cx}" y="430" text-anchor="middle" fill="#c9d4ff" font-size="48">🏆</text>`,
      `<text x="${cx}" y="520" text-anchor="middle" fill="#c9d4ff" font-size="44">${esc(sl.title || "")}</text>`
    );
    const rowW = 780;
    const rowH = 108;
    const gap = 18;
    const startY = 640;
    nb.rows.forEach((r, i) => {
      const y = startY + i * (rowH + gap);
      const fill = r.you ? "#ffd479" : "rgba(255,255,255,0.08)";
      const textFill = r.you ? "#241a00" : "#ffffff";
      parts.push(
        `<rect x="${cx - rowW / 2}" y="${y}" width="${rowW}" height="${rowH}" rx="18" fill="${fill}"/>`,
        `<text x="${cx - rowW / 2 + 40}" y="${y + rowH / 2 + 14}" fill="${textFill}" font-size="40" font-weight="${r.you ? 800 : 500}">#${esc(r.rank)}</text>`,
        `<text x="${cx - rowW / 2 + 150}" y="${y + rowH / 2 + 14}" fill="${textFill}" font-size="40" font-weight="${r.you ? 800 : 500}">${esc(r.name)}</text>`,
        `<text x="${cx + rowW / 2 - 40}" y="${y + rowH / 2 + 14}" text-anchor="end" fill="${textFill}" font-size="36" opacity="0.9">${esc(r.displayValue ?? r.value)}</text>`
      );
    });
    const afterRows = startY + nb.rows.length * (rowH + gap) + 60;
    const rankText =
      nb.rank != null && nb.total != null
        ? `You're #${esc(nb.rank)} of ${esc(nb.total)}`
        : nb.total != null
          ? `${esc(nb.total)} in total`
          : "";
    if (rankText) {
      parts.push(
        `<text x="${cx}" y="${afterRows}" text-anchor="middle" fill="#ffd479" font-size="40" font-weight="700">${rankText}</text>`
      );
    }
  } else if (sl.kind === "vibe") {
    parts.push(
      `<text x="${cx}" y="640" text-anchor="middle" font-size="150">${esc(sl.emoji || "🎭")}</text>`,
      `<text x="${cx}" y="800" text-anchor="middle" fill="#c9d4ff" font-size="46">${esc(sl.flavor || "This year, you were a")}</text>`,
      `<text x="${cx}" y="960" text-anchor="middle" fill="#ffffff" font-size="110" font-weight="800">${tspans(wrap(sl.label, 16), cx, 120)}</text>`,
      `<text x="${cx}" y="${960 + Math.max(1, wrap(sl.label, 16).length) * 120 + 40}" text-anchor="middle" fill="#aeb9de" font-size="40">${tspans(wrap(sl.blurb, 34), cx, 52)}</text>`
    );
  } else {
    // "stat" (and the "empty" fallback, which is shaped the same)
    const flavorLines = wrap(sl.flavor, 26);
    const statLines = wrap(sl.stat, 15);
    let y = 560;
    parts.push(`<text x="${cx}" y="${y}" text-anchor="middle" font-size="170">${esc(sl.emoji || "✨")}</text>`);
    y += 150;
    parts.push(`<text x="${cx}" y="${y}" text-anchor="middle" fill="#c9d4ff" font-size="46">${tspans(flavorLines, cx, 58)}</text>`);
    y += flavorLines.length * 58 + 90;
    parts.push(`<text x="${cx}" y="${y}" text-anchor="middle" fill="#ffffff" font-size="112" font-weight="800">${tspans(statLines, cx, 122)}</text>`);
    y += statLines.length * 122 + 20;
    if (sl.sub) {
      const subLines = wrap(sl.sub, 34);
      parts.push(`<text x="${cx}" y="${y}" text-anchor="middle" fill="#aeb9de" font-size="40">${tspans(subLines, cx, 50)}</text>`);
      y += subLines.length * 50 + 20;
    }
    if (sl.rank) {
      const rankLines = wrap(sl.rank, 30);
      parts.push(`<text x="${cx}" y="${y + 30}" text-anchor="middle" fill="#ffd479" font-size="42" font-weight="700">${tspans(rankLines, cx, 52)}</text>`);
    }
  }

  parts.push(footer(siteName, label));
  return frame(sl.mood, parts.join("\n  "), ctx.backgroundDataUri || null);
}
