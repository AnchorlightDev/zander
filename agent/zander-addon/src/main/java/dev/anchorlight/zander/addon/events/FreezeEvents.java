package dev.anchorlight.zander.addon.events;

import org.bukkit.entity.Player;
import org.bukkit.entity.Projectile;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.bukkit.event.entity.EntityDamageEvent;
import org.bukkit.event.inventory.InventoryOpenEvent;
import org.bukkit.event.player.PlayerCommandPreprocessEvent;
import org.bukkit.event.player.PlayerInteractEvent;
import org.bukkit.event.player.PlayerMoveEvent;
import org.bukkit.event.player.PlayerTeleportEvent;
import dev.anchorlight.zander.addon.service.FreezeService;

public class FreezeEvents implements Listener {
    private final FreezeService freezeService;

    public FreezeEvents(FreezeService freezeService) {
        this.freezeService = freezeService;
    }

    @EventHandler
    public void onPlayerMove(PlayerMoveEvent event) {
        if (freezeService.isFrozen(event.getPlayer().getUniqueId())) {
            // Check if player has actually moved position, not just rotated
            if (event.getFrom().getX() != event.getTo().getX() ||
                event.getFrom().getY() != event.getTo().getY() ||
                event.getFrom().getZ() != event.getTo().getZ()) {
                event.setCancelled(true);
            }
        }
    }

    @EventHandler
    public void onInventoryOpen(InventoryOpenEvent event) {
        if (freezeService.isFrozen(event.getPlayer().getUniqueId())) {
            event.setCancelled(true);
        }
    }

    @EventHandler
    public void onEntityDamage(EntityDamageEvent event) {
        if (event.getEntity() instanceof Player player) {
            if (freezeService.isFrozen(player.getUniqueId())) {
                event.setCancelled(true);
            }
        }
    }

    @EventHandler
    public void onEntityDamageByEntity(EntityDamageByEntityEvent event) {
        if (event.getDamager() instanceof Player player) {
            if (freezeService.isFrozen(player.getUniqueId())) {
                event.setCancelled(true);
            }
        } else if (event.getDamager() instanceof Projectile projectile && projectile.getShooter() instanceof Player player) {
            if (freezeService.isFrozen(player.getUniqueId())) {
                event.setCancelled(true);
            }
        }
    }

    @EventHandler
    public void onBlockBreak(BlockBreakEvent event) {
        if (freezeService.isFrozen(event.getPlayer().getUniqueId())) {
            event.setCancelled(true);
        }
    }

    @EventHandler
    public void onBlockPlace(BlockPlaceEvent event) {
        if (freezeService.isFrozen(event.getPlayer().getUniqueId())) {
            event.setCancelled(true);
        }
    }

    @EventHandler
    public void onPlayerInteract(PlayerInteractEvent event) {
        if (freezeService.isFrozen(event.getPlayer().getUniqueId())) {
            event.setCancelled(true);
        }
    }

    @EventHandler
    public void onPlayerCommand(PlayerCommandPreprocessEvent event) {
        if (freezeService.isFrozen(event.getPlayer().getUniqueId())) {
            String command = event.getMessage().split(" ")[0].toLowerCase();
            if (command.equals("/spawn") || command.equals("/home") || command.equals("/tp") || command.equals("/tpa") || command.equals("/tpask")) {
                event.setCancelled(true);
                event.getPlayer().sendMessage(net.kyori.adventure.text.Component.text("You cannot use this command while frozen.", net.kyori.adventure.text.format.NamedTextColor.RED));
            }
        }
    }

    @EventHandler
    public void onPlayerTeleport(PlayerTeleportEvent event) {
        if (freezeService.isFrozen(event.getPlayer().getUniqueId())) {
            if (event.getCause() != PlayerTeleportEvent.TeleportCause.UNKNOWN) {
                event.setCancelled(true);
                event.getPlayer().sendMessage(net.kyori.adventure.text.Component.text("You cannot teleport while frozen.", net.kyori.adventure.text.format.NamedTextColor.RED));
            }
        }
    }
}
