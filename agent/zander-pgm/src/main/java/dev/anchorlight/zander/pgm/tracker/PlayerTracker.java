package dev.anchorlight.zander.pgm.tracker;

import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.PlayerDeathEvent;
import dev.anchorlight.zander.pgm.ZanderPGMPlugin;
import dev.anchorlight.zander.pgm.api.dto.PlayerDeathEventDto;
import dev.anchorlight.zander.pgm.pgm.MatchIdentityService;
import dev.anchorlight.zander.pgm.progression.XpService;
import dev.anchorlight.zander.pgm.stats.PlayerStats;

/**
 * Tracks kills, deaths, first blood and killstreak milestones from Bukkit death
 * events, and emits PLAYER_DEATH. Works whether or not PGM's own death event is
 * available, so death tracking is robust across PGM versions.
 */
public class PlayerTracker implements Listener {

    private final ZanderPGMPlugin plugin;
    private final MatchTracker matchTracker;
    private final KillstreakTracker killstreaks = new KillstreakTracker();

    public PlayerTracker(ZanderPGMPlugin plugin, MatchTracker matchTracker) {
        this.plugin = plugin;
        this.matchTracker = matchTracker;
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onDeath(PlayerDeathEvent event) {
        if (!plugin.cfg().feature("playerStats")) {
            return;
        }
        Player victim = event.getEntity();
        Player killer = victim.getKiller();
        MatchIdentityService.Identity id = plugin.identity().current();
        String matchId = id != null ? id.matchId : null;

        PlayerStats victimStats = plugin.stats().player(victim.getUniqueId(), victim.getName());
        victimStats.deaths++;
        killstreaks.onDeath(victimStats);

        PlayerDeathEventDto dto = new PlayerDeathEventDto();
        dto.victimUuid = victim.getUniqueId().toString();
        dto.victimName = victim.getName();
        dto.cause = victim.getLastDamageCause() != null
                ? victim.getLastDamageCause().getCause().name() : "UNKNOWN";
        if (id != null) {
            dto.matchId = id.matchId;
            dto.mapKey = id.mapKey;
            dto.mapName = id.mapName;
        }

        if (killer != null && !killer.getUniqueId().equals(victim.getUniqueId())) {
            PlayerStats killerStats = plugin.stats().player(killer.getUniqueId(), killer.getName());
            killerStats.kills++;
            dto.killerUuid = killer.getUniqueId().toString();
            dto.killerName = killer.getName();
            if (killer.getInventory().getItemInMainHand().getType() != org.bukkit.Material.AIR) {
                dto.weapon = killer.getInventory().getItemInMainHand().getType().name();
            }

            plugin.xp().award(killerStats, XpService.Reason.KILL, matchId);

            if (matchTracker.claimFirstBlood()) {
                killerStats.firstBloods++;
                plugin.xp().award(killerStats, XpService.Reason.FIRST_BLOOD, matchId);
                org.bukkit.Bukkit.broadcastMessage("§6[Mixed] §cFirst blood §7by §f" + killer.getName());
            }

            int milestone = killstreaks.onKill(killerStats);
            if (milestone > 0) {
                plugin.xp().award(killerStats, XpService.Reason.KILLSTREAK, matchId);
                org.bukkit.Bukkit.broadcastMessage("§6[Mixed] §f" + killer.getName()
                        + " §eis on a §f" + milestone + " §ekillstreak!");
            }
            plugin.achievements().evaluate(killerStats, matchId);
        }

        plugin.api().send(dto);
        plugin.ws().send(dto);
        plugin.achievements().evaluate(victimStats, matchId);
    }
}
