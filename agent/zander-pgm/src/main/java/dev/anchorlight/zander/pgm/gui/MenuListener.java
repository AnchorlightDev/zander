package dev.anchorlight.zander.pgm.gui;

import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.inventory.InventoryClickEvent;
import org.bukkit.inventory.InventoryHolder;

/** Single global listener shared by every {@link Menu}. Register once in onEnable. */
public class MenuListener implements Listener {

    @EventHandler
    public void onClick(InventoryClickEvent event) {
        InventoryHolder holder = event.getInventory().getHolder();
        if (holder instanceof Menu menu) {
            event.setCancelled(true);
            menu.handleClick(event);
        }
    }
}
