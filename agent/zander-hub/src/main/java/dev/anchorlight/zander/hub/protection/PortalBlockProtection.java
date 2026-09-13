package dev.anchorlight.zander.hub.protection;

import dev.anchorlight.stonelib.block.SafeBlocks;
import org.bukkit.block.BlockState;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.world.PortalCreateEvent;

/**
 * Stops vanilla portal generation (lit Nether frames, paired exit portals, End
 * platforms) from replacing blocks that already exist in the world. If any block
 * the portal would place differs from a non-empty block already there, the whole
 * portal creation is cancelled rather than partially carving through builds.
 */
public class PortalBlockProtection implements Listener {

    @EventHandler(priority = EventPriority.HIGH, ignoreCancelled = true)
    public void onPortalCreate(PortalCreateEvent event) {
        for (BlockState planned : event.getBlocks()) {
            if (SafeBlocks.wouldOverwrite(planned.getBlock().getType(), planned.getType())) {
                event.setCancelled(true);
                return;
            }
        }
    }
}
