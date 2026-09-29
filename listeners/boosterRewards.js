import { Listener } from "@sapphire/framework";
import { syncBoosterRewardsForMember } from "../controllers/boosterRewardController.js";

/**
 * Booster rewards, live: when a member starts or stops boosting the server,
 * grant or revoke the configured rank(s) straight away.
 * cron/boosterRewardSyncCron.js sweeps every 30 minutes for anything missed
 * (members leaving the server, restarts, the rank list changing).
 */
export class BoosterRewardsListener extends Listener {
  constructor(context, options) {
    super(context, {
      ...options,
      once: false,
      event: "guildMemberUpdate",
    });
  }

  async run(oldMember, newMember) {
    if (!newMember?.guild || newMember.user?.bot) return;
    if (Boolean(oldMember?.premiumSince) === Boolean(newMember.premiumSince)) return;

    try {
      await syncBoosterRewardsForMember(newMember);
    } catch (error) {
      console.error("[boosterRewards] Live sync failed:", error.message);
    }
  }
}
