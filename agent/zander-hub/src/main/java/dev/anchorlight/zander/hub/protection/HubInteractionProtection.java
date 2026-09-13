package dev.anchorlight.zander.hub.protection;

import dev.anchorlight.zander.hub.ZanderHubMain;
import org.bukkit.Material;
import org.bukkit.block.Block;
import org.bukkit.event.Event;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.Action;
import org.bukkit.event.player.PlayerInteractEvent;

public class HubInteractionProtection implements Listener {

    ZanderHubMain plugin;
    public HubInteractionProtection(ZanderHubMain plugin) {
        this.plugin = plugin;
    }

    // Block user from interacting or using any items
    @EventHandler(priority = EventPriority.HIGH)
    public void onPlayerInteract(PlayerInteractEvent event) {
        Block clicked = event.getClickedBlock();
        if (clicked == null)
            return;

        // Used if the Hub needs to be edited by Senior Staff.
        if (event.getPlayer().hasPermission("zander.hub.build")) {
            event.setCancelled(false);
            return;
        }

        // Allows access for Doors and Buttons to be used.
        Material clickedOn = clicked.getType();
        boolean clickedOnDoor = clickedOn == Material.DARK_OAK_DOOR
                || clickedOn == Material.ACACIA_DOOR
                || clickedOn == Material.BAMBOO_DOOR
                || clickedOn == Material.BIRCH_DOOR
                || clickedOn == Material.CHERRY_DOOR
                || clickedOn == Material.CRIMSON_DOOR
                || clickedOn == Material.IRON_DOOR
                || clickedOn == Material.JUNGLE_DOOR
                || clickedOn == Material.MANGROVE_DOOR
                || clickedOn == Material.OAK_DOOR
                || clickedOn == Material.SPRUCE_DOOR;

        boolean clickedOnButton = clickedOn == Material.BAMBOO_BUTTON
                || clickedOn == Material.ACACIA_BUTTON
                || clickedOn == Material.BIRCH_BUTTON
                || clickedOn == Material.CHERRY_BUTTON
                || clickedOn == Material.CRIMSON_BUTTON
                || clickedOn == Material.DARK_OAK_BUTTON
                || clickedOn == Material.JUNGLE_BUTTON
                || clickedOn == Material.MANGROVE_BUTTON
                || clickedOn == Material.OAK_BUTTON
                || clickedOn == Material.POLISHED_BLACKSTONE_BUTTON
                || clickedOn == Material.SPRUCE_BUTTON
                || clickedOn == Material.STONE_BUTTON
                || clickedOn == Material.WARPED_BUTTON;

        if (clickedOnDoor || clickedOnButton) {
            event.setCancelled(false);
        } else {
            event.setCancelled(true);
            event.setUseInteractedBlock(Event.Result.DENY);
            event.setUseItemInHand(Event.Result.DENY);
        }

        // Allows Pressure Plates to be used.
        boolean onPressurePlate = clickedOn == Material.BIRCH_PRESSURE_PLATE
                || clickedOn == Material.ACACIA_PRESSURE_PLATE
                || clickedOn == Material.BAMBOO_PRESSURE_PLATE
                || clickedOn == Material.CHERRY_PRESSURE_PLATE
                || clickedOn == Material.CRIMSON_PRESSURE_PLATE
                || clickedOn == Material.DARK_OAK_PRESSURE_PLATE
                || clickedOn == Material.HEAVY_WEIGHTED_PRESSURE_PLATE
                || clickedOn == Material.JUNGLE_PRESSURE_PLATE
                || clickedOn == Material.LIGHT_WEIGHTED_PRESSURE_PLATE
                || clickedOn == Material.MANGROVE_PRESSURE_PLATE
                || clickedOn == Material.OAK_PRESSURE_PLATE
                || clickedOn == Material.POLISHED_BLACKSTONE_PRESSURE_PLATE
                || clickedOn == Material.SPRUCE_PRESSURE_PLATE
                || clickedOn == Material.STONE_PRESSURE_PLATE
                || clickedOn == Material.WARPED_PRESSURE_PLATE;

        if (event.getAction().equals(Action.PHYSICAL)) {
            if (onPressurePlate) {
                event.setCancelled(false);
            }
        }
    }
}
