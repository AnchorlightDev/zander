package dev.anchorlight.zander.hub.portal;

import dev.anchorlight.stonelib.block.SafeBlocks;
import dev.anchorlight.stonelib.display.TintPanel;
import dev.anchorlight.stonelib.region.Cuboid;
import dev.anchorlight.stonelib.region.RegionIndex;
import org.bukkit.Axis;
import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.PortalType;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.block.data.Orientable;
import org.bukkit.entity.TextDisplay;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.BlockPhysicsEvent;
import org.bukkit.event.entity.EntityPortalEnterEvent;
import org.bukkit.event.world.ChunkLoadEvent;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Draws each portal's {@link PortalAppearance} into the world and keeps it intact.
 * <p>
 * {@code NETHER} portals place real nether portal blocks, but only into empty space —
 * existing blocks are never replaced. Those blocks have no obsidian frame, so physics
 * updates that would break them are cancelled, and vanilla Nether travel from them is
 * suppressed so only the portal's own destination fires.
 * <p>
 * {@code TINT} portals are a {@link TintPanel}. Its displays vanish with their chunk and
 * are respawned when it loads again, so nothing is ever left behind in the world save.
 */
public class PortalRenderer implements Listener {
    /// Upper bound on blocks a single nether-style portal may fill.
    public static final long MAX_NETHER_VOLUME = 4096;

    private final PortalService portalService;
    private final RegionIndex<Portal> index;
    private final Map<String, List<TextDisplay>> tintPanels = new HashMap<>();

    public PortalRenderer(PortalService portalService, RegionIndex<Portal> index) {
        this.portalService = portalService;
        this.index = index;
    }

    public void renderAll() {
        for (Portal portal : portalService.all()) {
            apply(null, portal);
        }
    }

    /// Removes tint panels on shutdown. Nether portal blocks are world blocks and stay.
    public void removeAllTints() {
        for (List<TextDisplay> panels : tintPanels.values()) {
            panels.forEach(TextDisplay::remove);
        }
        tintPanels.clear();
    }

    public void apply(Portal before, Portal after) {
        if (before != null) {
            removeTint(before);
            boolean stillSameNether = after != null
                    && after.appearance().style() == PortalAppearance.Style.NETHER
                    && after.region().equals(before.region());
            if (before.appearance().style() == PortalAppearance.Style.NETHER && !stillSameNether) {
                clearNether(before.region());
            }
        }
        if (after != null) {
            switch (after.appearance().style()) {
                case NETHER -> fillNether(after.region());
                case TINT -> spawnTint(after);
                case NONE -> { }
            }
        }
    }

    /// Counts blocks in the region that a nether fill leaves untouched because they're occupied.
    public int countOccupied(Cuboid region) {
        World world = Bukkit.getWorld(region.world());
        return world == null ? 0 : SafeBlocks.countOccupied(world, region, Material.NETHER_PORTAL);
    }

    private void fillNether(Cuboid region) {
        World world = Bukkit.getWorld(region.world());
        if (world == null || region.volume() > MAX_NETHER_VOLUME) {
            return;
        }
        Orientable data = (Orientable) Material.NETHER_PORTAL.createBlockData();
        data.setAxis(region.sizeX() >= region.sizeZ() ? Axis.X : Axis.Z);
        SafeBlocks.fill(world, region, data);
    }

    private void clearNether(Cuboid region) {
        World world = Bukkit.getWorld(region.world());
        if (world != null && region.volume() <= MAX_NETHER_VOLUME) {
            SafeBlocks.clear(world, region, Material.NETHER_PORTAL);
        }
    }

    private void removeTint(Portal portal) {
        List<TextDisplay> panels = tintPanels.remove(PortalIdValidator.normalise(portal.id()));
        if (panels != null) {
            panels.forEach(TextDisplay::remove);
        }
    }

    private void spawnTint(Portal portal) {
        World world = Bukkit.getWorld(portal.region().world());
        // Only spawn into loaded chunks; ChunkLoadEvent retries once they are.
        if (world == null || !TintPanel.anchorsLoaded(world, portal.region())) {
            return;
        }
        tintPanels.put(PortalIdValidator.normalise(portal.id()),
                TintPanel.spawn(world, portal.region(), portal.appearance().argb()));
    }

    private boolean tintIntact(Portal portal) {
        List<TextDisplay> panels = tintPanels.get(PortalIdValidator.normalise(portal.id()));
        return panels != null && panels.stream().allMatch(TextDisplay::isValid);
    }

    private boolean isNetherPortalBlock(World world, int x, int y, int z) {
        for (Portal portal : index.allAt(world.getName(), x, y, z)) {
            if (portal.appearance().style() == PortalAppearance.Style.NETHER) {
                return true;
            }
        }
        return false;
    }

    @EventHandler
    public void onChunkLoad(ChunkLoadEvent event) {
        for (Portal portal : index.candidatesFor(event.getWorld().getName(), event.getChunk().getX(), event.getChunk().getZ())) {
            if (portal.appearance().style() == PortalAppearance.Style.TINT && !tintIntact(portal)) {
                removeTint(portal);
                spawnTint(portal);
            }
        }
    }

    /// Frameless portal blocks would otherwise pop the moment a neighbouring block updates.
    @EventHandler(ignoreCancelled = true)
    public void onPhysics(BlockPhysicsEvent event) {
        Block block = event.getBlock();
        if (block.getType() == Material.NETHER_PORTAL
                && isNetherPortalBlock(block.getWorld(), block.getX(), block.getY(), block.getZ())) {
            event.setCancelled(true);
        }
    }

    /// Stops vanilla Nether travel so the portal's configured destination is the only thing that fires.
    @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
    public void onPortalEnter(EntityPortalEnterEvent event) {
        Location location = event.getLocation();
        if (event.getPortalType() == PortalType.NETHER && location.getWorld() != null
                && isNetherPortalBlock(location.getWorld(), location.getBlockX(), location.getBlockY(), location.getBlockZ())) {
            event.setCancelled(true);
        }
    }
}
