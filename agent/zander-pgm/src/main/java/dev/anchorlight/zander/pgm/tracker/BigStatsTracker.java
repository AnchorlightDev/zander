package dev.anchorlight.zander.pgm.tracker;

import org.bukkit.entity.Player;
import org.bukkit.entity.Projectile;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.bukkit.event.entity.EntityShootBowEvent;
import org.bukkit.event.entity.ProjectileHitEvent;
import dev.anchorlight.zander.pgm.ZanderPGMPlugin;
import dev.anchorlight.zander.pgm.stats.PlayerStats;

/**
 * "Big stats": damage dealt/taken, bow shots/hits/accuracy, and blocks
 * broken/placed. Each metric is gated by its config flag.
 */
public class BigStatsTracker implements Listener {

    private final ZanderPGMPlugin plugin;

    public BigStatsTracker(ZanderPGMPlugin plugin) {
        this.plugin = plugin;
    }

    private boolean enabled() {
        return plugin.cfg().feature("bigStats");
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onDamage(EntityDamageByEntityEvent event) {
        if (!enabled() || !plugin.cfg().includeDamageStats) return;
        if (!(event.getEntity() instanceof Player victim)) return;
        double amount = event.getFinalDamage();

        Player damager = null;
        if (event.getDamager() instanceof Player p) {
            damager = p;
        } else if (event.getDamager() instanceof Projectile proj
                && proj.getShooter() instanceof Player p) {
            damager = p;
        }

        plugin.stats().player(victim.getUniqueId(), victim.getName()).damageTaken += amount;
        if (damager != null && !damager.getUniqueId().equals(victim.getUniqueId())) {
            plugin.stats().player(damager.getUniqueId(), damager.getName()).damageDealt += amount;
        }
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onBowShoot(EntityShootBowEvent event) {
        if (!enabled() || !plugin.cfg().includeBowStats) return;
        if (event.getEntity() instanceof Player p) {
            PlayerStats stats = plugin.stats().player(p.getUniqueId(), p.getName());
            stats.bowShots++;
            stats.recomputeBowAccuracy();
        }
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onProjectileHit(ProjectileHitEvent event) {
        if (!enabled() || !plugin.cfg().includeBowStats) return;
        if (event.getHitEntity() instanceof Player
                && event.getEntity().getShooter() instanceof Player shooter) {
            PlayerStats stats = plugin.stats().player(shooter.getUniqueId(), shooter.getName());
            stats.bowHits++;
            stats.recomputeBowAccuracy();
        }
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onBlockBreak(BlockBreakEvent event) {
        if (!enabled() || !plugin.cfg().includeBlockStats) return;
        Player p = event.getPlayer();
        plugin.stats().player(p.getUniqueId(), p.getName()).blocksBroken++;
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onBlockPlace(BlockPlaceEvent event) {
        if (!enabled() || !plugin.cfg().includeBlockStats) return;
        Player p = event.getPlayer();
        plugin.stats().player(p.getUniqueId(), p.getName()).blocksPlaced++;
    }
}
