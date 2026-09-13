package dev.anchorlight.zander.addon.events;

import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import dev.anchorlight.zander.addon.service.StoreCommandService;

public class StoreCommandEvents implements Listener {

    private final StoreCommandService storeCommandService;

    public StoreCommandEvents(StoreCommandService storeCommandService) {
        this.storeCommandService = storeCommandService;
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onPlayerJoin(PlayerJoinEvent event) {
        storeCommandService.onPlayerJoin(
                event.getPlayer().getUniqueId(),
                event.getPlayer().getName()
        );
    }
}
