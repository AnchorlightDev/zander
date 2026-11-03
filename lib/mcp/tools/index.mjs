/**
 * lib/mcp/tools/index.mjs
 *
 * Every MCP tool, and the rule for which ones a given staff member sees: a
 * tool appears only when its module is switched on and the caller holds one of
 * its permission nodes. Each write tool re-checks inside its handler and the
 * underlying Zander route checks again, so hiding is a convenience, not the
 * security boundary.
 */

import { filterVisibleTools } from "../visibility.mjs";
import { eventTools } from "./events.mjs";
import { rankTools } from "./ranks.mjs";
import { announcementTools } from "./announcements.mjs";
import { moderationTools } from "./moderation.mjs";

const whoamiTool = {
  name: "whoami",
  title: "Who am I signed in as",
  description:
    "The CFC account Claude is acting as, its ranks, and which Zander areas it can use through these tools.",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true },
  async handler(_args, ctx) {
    const areas = [...new Set(visibleTools(ctx).map((t) => t.name.split("_")[0]))].filter((a) => a !== "whoami");
    return {
      username: ctx.user.username,
      userId: ctx.user.userId,
      ranks: (ctx.user.ranks || []).map((r) => r.rankSlug),
      isStaff: Boolean(ctx.user.isStaff),
      areas,
    };
  },
};

export const ALL_TOOLS = [whoamiTool, ...eventTools, ...rankTools, ...announcementTools, ...moderationTools];

/** Tools the caller may see, given their permissions and the module switches. */
export function visibleTools(ctx) {
  return filterVisibleTools(ALL_TOOLS, ctx);
}
