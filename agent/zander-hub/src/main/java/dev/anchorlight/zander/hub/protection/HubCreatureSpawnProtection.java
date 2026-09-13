package dev.anchorlight.zander.hub.protection;

import dev.anchorlight.zander.hub.ZanderHubMain;
import org.bukkit.entity.EntityType;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.CreatureSpawnEvent;

public class HubCreatureSpawnProtection implements Listener {

    ZanderHubMain plugin;
    public HubCreatureSpawnProtection(ZanderHubMain plugin) {
        this.plugin = plugin;
    }

    // Block entity spawning and the use of spawn eggs
    @EventHandler
    public void onCreatureSpawn(CreatureSpawnEvent event) {
        CreatureSpawnEvent.SpawnReason reason = event.getSpawnReason();
        boolean isValidReason = reason == CreatureSpawnEvent.SpawnReason.DEFAULT
//                || reason == CreatureSpawnEvent.SpawnReason.CHUNK_GEN // Deprecated. Covered by NATURAL?
                || reason == CreatureSpawnEvent.SpawnReason.NATURAL
                || reason == CreatureSpawnEvent.SpawnReason.NETHER_PORTAL
                || reason == CreatureSpawnEvent.SpawnReason.DISPENSE_EGG
                || reason == CreatureSpawnEvent.SpawnReason.REINFORCEMENTS;

        if (isValidReason) {
            boolean isPillagerOrVillager = event.getEntity().getType().equals(EntityType.VILLAGER)
                    || event.getEntity().getType().equals(EntityType.PILLAGER);

            event.setCancelled(!isPillagerOrVillager);
        }
    }
}
