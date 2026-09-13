package dev.anchorlight.zander.hub.commands.portal;

import dev.anchorlight.stonelib.display.ArgbColours;
import dev.anchorlight.stonelib.region.Cuboid;
import dev.anchorlight.stonelib.region.SelectionManager;
import dev.anchorlight.stonelib.region.SelectionWand;
import dev.anchorlight.zander.hub.ConfigurationManager;
import dev.anchorlight.zander.hub.ZanderHubMain;
import dev.anchorlight.zander.hub.bridge.BridgeMessage;
import dev.anchorlight.zander.hub.portal.LocationPortalDestination;
import dev.anchorlight.zander.hub.portal.Portal;
import dev.anchorlight.zander.hub.portal.PortalAppearance;
import dev.anchorlight.zander.hub.portal.PortalRenderer;
import dev.anchorlight.zander.hub.portal.PortalService;
import dev.anchorlight.zander.hub.portal.ServerPortalDestination;
import net.kyori.adventure.text.minimessage.MiniMessage;
import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.Sound;
import org.bukkit.World;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.command.TabCompleter;
import org.bukkit.entity.Player;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

public class PortalCommand implements CommandExecutor, TabCompleter {
    private static final MiniMessage MM = MiniMessage.miniMessage();
    private static final List<String> SUBCOMMANDS = List.of("wand", "create", "delete", "list", "info", "enable",
            "disable", "setserver", "setlocation", "setpermission", "setdisplay", "setcooldown", "setsound",
            "setstyle", "setcolour", "reload", "tp", "send");

    private final PortalService portalService;
    private final SelectionManager selections;
    private final SelectionWand wand;
    private final PortalRenderer renderer;

    public PortalCommand(PortalService portalService, SelectionManager selections, SelectionWand wand,
            PortalRenderer renderer) {
        this.portalService = portalService;
        this.selections = selections;
        this.wand = wand;
        this.renderer = renderer;
    }

    private void msg(CommandSender sender, String message) {
        sender.sendMessage(MM.deserialize(message));
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (args.length == 0) {
            msg(sender, "<gray>Usage: /zportal <subcommand> [args]</gray>");
            return true;
        }
        String sub = args[0].toLowerCase(java.util.Locale.ROOT);
        String[] rest = java.util.Arrays.copyOfRange(args, 1, args.length);

        switch (sub) {
            case "wand" -> handleWand(sender);
            case "create" -> handleCreate(sender, rest);
            case "delete" -> handleDelete(sender, rest);
            case "list" -> handleList(sender);
            case "info" -> handleInfo(sender, rest);
            case "enable" -> handleEnable(sender, rest, true);
            case "disable" -> handleEnable(sender, rest, false);
            case "setserver" -> handleSetServer(sender, rest);
            case "setlocation" -> handleSetLocation(sender, rest);
            case "setpermission" -> handleSetPermission(sender, rest);
            case "setdisplay" -> handleSetDisplay(sender, rest);
            case "setcooldown" -> handleSetCooldown(sender, rest);
            case "setsound" -> handleSetSound(sender, rest);
            case "setstyle" -> handleSetStyle(sender, rest);
            case "setcolour", "setcolor" -> handleSetColour(sender, rest);
            case "reload" -> handleReload(sender);
            case "tp" -> handleTp(sender, rest);
            case "send" -> handleSend(sender, rest);
            default -> msg(sender, "<red>Unknown subcommand: " + sub + "</red>");
        }
        return true;
    }

    private boolean requirePermission(CommandSender sender, String permission) {
        if (!sender.hasPermission(permission)) {
            msg(sender, "<red>You do not have permission to do that.</red>");
            return false;
        }
        return true;
    }

    private void handleWand(CommandSender sender) {
        if (!requirePermission(sender, "zanderhub.portal.wand") || !(sender instanceof Player player)) {
            if (!(sender instanceof Player)) {
                msg(sender, "<red>Only players can receive the portal wand.</red>");
            }
            return;
        }
        String materialName = ZanderHubMain.plugin.getConfig().getString("portal-wand.material", "BLAZE_ROD");
        Material material = Material.matchMaterial(materialName);
        String display = ZanderHubMain.plugin.getConfig().getString("portal-wand.display", "<gold>Portal Wand</gold>");
        player.getInventory().addItem(wand.create(material == null ? Material.BLAZE_ROD : material, MM.deserialize(display)));
        msg(player, "<yellow>Portal wand given. Left-click = position 1, right-click = position 2.</yellow>");
    }

    private void handleCreate(CommandSender sender, String[] args) {
        if (!requirePermission(sender, "zanderhub.portal.create") || !(sender instanceof Player player)) {
            return;
        }
        if (args.length != 1) {
            msg(sender, "<red>Usage: /zportal create <id></red>");
            return;
        }
        String id = args[0];
        if (portalService.find(id).isPresent()) {
            msg(sender, "<red>A portal with id '" + id + "' already exists.</red>");
            return;
        }
        Optional<Cuboid> region = selections.selection(player.getUniqueId());
        if (region.isEmpty()) {
            msg(sender, "<red>Select two positions with the portal wand first (same world).</red>");
            return;
        }
        try {
            Portal portal = new Portal(id, id, false, region.get(),
                    new ServerPortalDestination("unset"), null, 2000L, null,
                    "<yellow>Sending you to " + id + "...</yellow>", "<red>You do not have access to " + id + ".</red>");
            portalService.put(portal);
            msg(sender, "<green>Portal '" + id + "' created (disabled). Set a destination with "
                    + "/zportal setserver " + id + " <server-id> or /zportal setlocation " + id
                    + ", then /zportal enable " + id + ".</green>");
        } catch (IllegalArgumentException e) {
            msg(sender, "<red>" + e.getMessage() + "</red>");
        }
    }

    private void handleDelete(CommandSender sender, String[] args) {
        if (!requirePermission(sender, "zanderhub.portal.delete")) {
            return;
        }
        if (args.length != 1) {
            msg(sender, "<red>Usage: /zportal delete <id></red>");
            return;
        }
        if (portalService.delete(args[0])) {
            msg(sender, "<green>Portal '" + args[0] + "' deleted.</green>");
        } else {
            msg(sender, "<red>No such portal: " + args[0] + "</red>");
        }
    }

    private void handleList(CommandSender sender) {
        if (!requirePermission(sender, "zanderhub.portal.list")) {
            return;
        }
        if (portalService.all().isEmpty()) {
            msg(sender, "<gray>No portals configured.</gray>");
            return;
        }
        for (Portal portal : portalService.all()) {
            msg(sender, (portal.enabled() ? "<green>" : "<red>") + portal.id() + " <gray>(" + portal.displayName() + ")</gray>");
        }
    }

    private void handleInfo(CommandSender sender, String[] args) {
        if (!requirePermission(sender, "zanderhub.portal.list") || args.length != 1) {
            if (args.length != 1) msg(sender, "<red>Usage: /zportal info <id></red>");
            return;
        }
        Optional<Portal> found = portalService.find(args[0]);
        if (found.isEmpty()) {
            msg(sender, "<red>No such portal: " + args[0] + "</red>");
            return;
        }
        Portal portal = found.get();
        msg(sender, "<gold>Portal: " + portal.id() + "</gold>");
        msg(sender, "<gray>Enabled: " + portal.enabled() + "</gray>");
        msg(sender, "<gray>Region: " + portal.region() + "</gray>");
        msg(sender, "<gray>Destination: " + portal.destination() + "</gray>");
        msg(sender, "<gray>Permission: " + (portal.permission() == null ? "none" : portal.permission()) + "</gray>");
        msg(sender, "<gray>Cooldown: " + portal.cooldownMs() + "ms</gray>");
        msg(sender, "<gray>Appearance: " + portal.appearance().style().name().toLowerCase(java.util.Locale.ROOT)
                + " (colour " + ArgbColours.format(portal.appearance().argb()) + ")</gray>");
    }

    private void handleEnable(CommandSender sender, String[] args, boolean enabled) {
        if (!requirePermission(sender, "zanderhub.portal.edit")) {
            return;
        }
        if (args.length != 1) {
            msg(sender, "<red>Usage: /zportal " + (enabled ? "enable" : "disable") + " <id></red>");
            return;
        }
        try {
            portalService.setEnabled(args[0], enabled);
            msg(sender, "<green>Portal '" + args[0] + "' " + (enabled ? "enabled" : "disabled") + ".</green>");
        } catch (IllegalArgumentException e) {
            msg(sender, "<red>" + e.getMessage() + "</red>");
        }
    }

    private void handleSetServer(CommandSender sender, String[] args) {
        if (!requirePermission(sender, "zanderhub.portal.edit") || args.length != 2) {
            if (args.length != 2) msg(sender, "<red>Usage: /zportal setserver <id> <server-id></red>");
            return;
        }
        Optional<Portal> found = portalService.find(args[0]);
        if (found.isEmpty()) {
            msg(sender, "<red>No such portal: " + args[0] + "</red>");
            return;
        }
        Portal existing = found.get();
        portalService.put(withDestination(existing, new ServerPortalDestination(args[1])));
        msg(sender, "<green>Portal '" + existing.id() + "' now sends to server '" + args[1] + "'.</green>");
    }

    private void handleSetLocation(CommandSender sender, String[] args) {
        if (!requirePermission(sender, "zanderhub.portal.edit") || !(sender instanceof Player player)) {
            if (!(sender instanceof Player)) msg(sender, "<red>Only players can use setlocation.</red>");
            return;
        }
        if (args.length != 1) {
            msg(sender, "<red>Usage: /zportal setlocation <id></red>");
            return;
        }
        Optional<Portal> found = portalService.find(args[0]);
        if (found.isEmpty()) {
            msg(sender, "<red>No such portal: " + args[0] + "</red>");
            return;
        }
        Location location = player.getLocation();
        LocationPortalDestination destination = new LocationPortalDestination(location.getWorld().getName(),
                location.getX(), location.getY(), location.getZ(), location.getYaw(), location.getPitch());
        portalService.put(withDestination(found.get(), destination));
        msg(player, "<green>Portal '" + found.get().id() + "' destination set to your current location.</green>");
    }

    private void handleSetPermission(CommandSender sender, String[] args) {
        if (!requirePermission(sender, "zanderhub.portal.edit") || args.length != 2) {
            if (args.length != 2) msg(sender, "<red>Usage: /zportal setpermission <id> <permission|none></red>");
            return;
        }
        Optional<Portal> found = portalService.find(args[0]);
        if (found.isEmpty()) {
            msg(sender, "<red>No such portal: " + args[0] + "</red>");
            return;
        }
        String permission = args[1].equalsIgnoreCase("none") ? null : args[1];
        Portal existing = found.get();
        portalService.put(new Portal(existing.id(), existing.displayName(), existing.enabled(), existing.region(),
                existing.destination(), permission, existing.cooldownMs(), existing.sound(),
                existing.successMessage(), existing.deniedMessage(), existing.appearance()));
        msg(sender, "<green>Portal '" + existing.id() + "' permission set to " + (permission == null ? "none" : permission) + ".</green>");
    }

    private void handleSetDisplay(CommandSender sender, String[] args) {
        if (!requirePermission(sender, "zanderhub.portal.edit") || args.length < 2) {
            if (args.length < 2) msg(sender, "<red>Usage: /zportal setdisplay <id> <display name></red>");
            return;
        }
        Optional<Portal> found = portalService.find(args[0]);
        if (found.isEmpty()) {
            msg(sender, "<red>No such portal: " + args[0] + "</red>");
            return;
        }
        String display = String.join(" ", java.util.Arrays.copyOfRange(args, 1, args.length));
        Portal existing = found.get();
        portalService.put(new Portal(existing.id(), display, existing.enabled(), existing.region(),
                existing.destination(), existing.permission(), existing.cooldownMs(), existing.sound(),
                existing.successMessage(), existing.deniedMessage(), existing.appearance()));
        msg(sender, "<green>Portal '" + existing.id() + "' display name updated.</green>");
    }

    private void handleSetCooldown(CommandSender sender, String[] args) {
        if (!requirePermission(sender, "zanderhub.portal.edit") || args.length != 2) {
            if (args.length != 2) msg(sender, "<red>Usage: /zportal setcooldown <id> <milliseconds></red>");
            return;
        }
        Optional<Portal> found = portalService.find(args[0]);
        if (found.isEmpty()) {
            msg(sender, "<red>No such portal: " + args[0] + "</red>");
            return;
        }
        long cooldownMs;
        try {
            cooldownMs = Long.parseLong(args[1]);
        } catch (NumberFormatException e) {
            msg(sender, "<red>Cooldown must be a number of milliseconds.</red>");
            return;
        }
        Portal existing = found.get();
        try {
            portalService.put(new Portal(existing.id(), existing.displayName(), existing.enabled(), existing.region(),
                    existing.destination(), existing.permission(), cooldownMs, existing.sound(),
                    existing.successMessage(), existing.deniedMessage(), existing.appearance()));
            msg(sender, "<green>Portal '" + existing.id() + "' cooldown set to " + cooldownMs + "ms.</green>");
        } catch (IllegalArgumentException e) {
            msg(sender, "<red>" + e.getMessage() + "</red>");
        }
    }

    private void handleSetSound(CommandSender sender, String[] args) {
        if (!requirePermission(sender, "zanderhub.portal.edit") || args.length != 2) {
            if (args.length != 2) msg(sender, "<red>Usage: /zportal setsound <id> <sound|none></red>");
            return;
        }
        Optional<Portal> found = portalService.find(args[0]);
        if (found.isEmpty()) {
            msg(sender, "<red>No such portal: " + args[0] + "</red>");
            return;
        }
        String sound = args[1].equalsIgnoreCase("none") ? null : args[1];
        if (sound != null) {
            try {
                Sound.valueOf(sound);
            } catch (IllegalArgumentException e) {
                msg(sender, "<red>Unknown sound: " + sound + "</red>");
                return;
            }
        }
        Portal existing = found.get();
        portalService.put(new Portal(existing.id(), existing.displayName(), existing.enabled(), existing.region(),
                existing.destination(), existing.permission(), existing.cooldownMs(), sound,
                existing.successMessage(), existing.deniedMessage(), existing.appearance()));
        msg(sender, "<green>Portal '" + existing.id() + "' sound updated.</green>");
    }

    private void handleSetStyle(CommandSender sender, String[] args) {
        if (!requirePermission(sender, "zanderhub.portal.edit") || args.length != 2) {
            if (args.length != 2) msg(sender, "<red>Usage: /zportal setstyle <id> <none|nether|tint></red>");
            return;
        }
        Optional<Portal> found = portalService.find(args[0]);
        if (found.isEmpty()) {
            msg(sender, "<red>No such portal: " + args[0] + "</red>");
            return;
        }
        Optional<PortalAppearance.Style> style = PortalAppearance.parseStyle(args[1]);
        if (style.isEmpty()) {
            msg(sender, "<red>Unknown style: " + args[1] + ". Use none, nether or tint.</red>");
            return;
        }
        applyAppearance(sender, found.get(), found.get().appearance().withStyle(style.get()));
    }

    private void handleSetColour(CommandSender sender, String[] args) {
        if (!requirePermission(sender, "zanderhub.portal.edit") || args.length != 2) {
            if (args.length != 2) msg(sender, "<red>Usage: /zportal setcolour <id> <#RRGGBB|#AARRGGBB|colour-name></red>");
            return;
        }
        Optional<Portal> found = portalService.find(args[0]);
        if (found.isEmpty()) {
            msg(sender, "<red>No such portal: " + args[0] + "</red>");
            return;
        }
        Optional<Integer> argb = ArgbColours.parse(args[1]);
        if (argb.isEmpty()) {
            msg(sender, "<red>Invalid colour: " + args[1] + ". Use #RRGGBB, #AARRGGBB or a dye colour name.</red>");
            return;
        }
        // Nether portal blocks can't be recoloured, so choosing a colour switches the portal to a tint.
        applyAppearance(sender, found.get(), new PortalAppearance(PortalAppearance.Style.TINT, argb.get()));
    }

    private void applyAppearance(CommandSender sender, Portal existing, PortalAppearance appearance) {
        if (appearance.style() == PortalAppearance.Style.NETHER
                && existing.region().volume() > PortalRenderer.MAX_NETHER_VOLUME) {
            msg(sender, "<red>Portal '" + existing.id() + "' is too large for the nether style ("
                    + existing.region().volume() + " blocks, max " + PortalRenderer.MAX_NETHER_VOLUME + ").</red>");
            return;
        }
        portalService.put(existing.withAppearance(appearance));

        String description = switch (appearance.style()) {
            case NONE -> "invisible";
            case NETHER -> "a nether portal";
            case TINT -> "a " + ArgbColours.format(appearance.argb()) + " tint";
        };
        msg(sender, "<green>Portal '" + existing.id() + "' is now " + description + ".</green>");
        if (appearance.style() == PortalAppearance.Style.NETHER) {
            int occupied = renderer.countOccupied(existing.region());
            if (occupied > 0) {
                msg(sender, "<yellow>" + occupied + " block(s) in the region were already occupied and left untouched.</yellow>");
            }
        }
    }

    private void handleReload(CommandSender sender) {
        if (!requirePermission(sender, "zanderhub.portal.reload")) {
            return;
        }
        try {
            portalService.reload();
            msg(sender, "<green>Reloaded " + portalService.all().size() + " portal(s).</green>");
        } catch (Exception e) {
            msg(sender, "<red>Portal reload failed: " + e.getMessage() + "</red>");
            ZanderHubMain.plugin.getLogger().warning("Portal reload failed: " + e.getMessage());
        }
    }

    private void handleTp(CommandSender sender, String[] args) {
        if (!requirePermission(sender, "zanderhub.portal.teleport") || !(sender instanceof Player player)) {
            if (!(sender instanceof Player)) msg(sender, "<red>Only players can teleport.</red>");
            return;
        }
        if (args.length != 1) {
            msg(sender, "<red>Usage: /zportal tp <id></red>");
            return;
        }
        Optional<Portal> found = portalService.find(args[0]);
        if (found.isEmpty()) {
            msg(sender, "<red>No such portal: " + args[0] + "</red>");
            return;
        }
        Cuboid region = found.get().region();
        World world = org.bukkit.Bukkit.getWorld(region.world());
        if (world == null) {
            msg(sender, "<red>Portal's world is not currently loaded.</red>");
            return;
        }
        int centreX = (region.minX() + region.maxX()) / 2;
        int centreZ = (region.minZ() + region.maxZ()) / 2;
        int safeY = Math.max(region.maxY() + 1, world.getHighestBlockYAt(centreX, centreZ) + 1);
        player.teleportAsync(new Location(world, centreX + 0.5, safeY, centreZ + 0.5));
        msg(player, "<green>Teleported to portal '" + found.get().id() + "'.</green>");
    }

    private void handleSend(CommandSender sender, String[] args) {
        if (!requirePermission(sender, "zanderhub.portal.send")) {
            return;
        }
        if (args.length < 1 || args.length > 2 || (args.length == 1 && !(sender instanceof Player))) {
            msg(sender, "<red>Usage: /zportal send <server-id> [player]</red>");
            return;
        }
        String serverId = args[0];
        Player target = args.length == 2 ? Bukkit.getPlayerExact(args[1]) : (Player) sender;
        if (target == null) {
            msg(sender, "<red>Player '" + args[1] + "' is not online on this server.</red>");
            return;
        }
        if (ZanderHubMain.bridgeClient == null) {
            msg(sender, "<red>The Velocity bridge is not available.</red>");
            return;
        }

        boolean self = target.equals(sender);
        msg(sender, "<yellow>Sending " + (self ? "you" : target.getName()) + " to " + serverId + "...</yellow>");
        // Velocity performs the transfer over the target's own connection and enforces their server access.
        ZanderHubMain.bridgeClient.sendConnectRequest(target, "", serverId)
                .whenComplete((response, error) -> Bukkit.getScheduler().runTask(ZanderHubMain.plugin, () -> {
                    String result;
                    if (error != null) {
                        result = "<red>Failed to send " + target.getName() + " to " + serverId + ": no response from Velocity.</red>";
                    } else {
                        result = switch (response) {
                            case BridgeMessage.ConnectStarted ignored ->
                                    "<green>Connecting " + target.getName() + " to " + serverId + ".</green>";
                            case BridgeMessage.ConnectDenied denied -> "<red>" + denied.reason() + "</red>";
                            case BridgeMessage.ConnectFailed failed -> "<red>" + failed.reason() + "</red>";
                            default -> "<red>Unexpected response from Velocity.</red>";
                        };
                    }
                    if (!(sender instanceof Player player) || player.isOnline()) {
                        msg(sender, result);
                    }
                    if (!self && target.isOnline() && response instanceof BridgeMessage.ConnectStarted) {
                        msg(target, "<yellow>You are being sent to " + serverId + "...</yellow>");
                    }
                }));
    }

    private static Portal withDestination(Portal existing, dev.anchorlight.zander.hub.portal.PortalDestination destination) {
        return new Portal(existing.id(), existing.displayName(), existing.enabled(), existing.region(), destination,
                existing.permission(), existing.cooldownMs(), existing.sound(),
                existing.successMessage(), existing.deniedMessage());
    }

    @Override
    public List<String> onTabComplete(CommandSender sender, Command command, String alias, String[] args) {
        if (args.length == 1) {
            return prefixMatch(SUBCOMMANDS, args[0]);
        }
        if (args.length == 2) {
            switch (args[0].toLowerCase(java.util.Locale.ROOT)) {
                case "delete", "info", "enable", "disable", "setserver", "setlocation", "setpermission",
                        "setdisplay", "setcooldown", "setsound", "setstyle", "setcolour", "setcolor", "tp" -> {
                    List<String> ids = new ArrayList<>();
                    for (Portal portal : portalService.all()) {
                        ids.add(portal.id());
                    }
                    return prefixMatch(ids, args[1]);
                }
                case "send" -> {
                    return prefixMatch(compassServerIds(), args[1]);
                }
                default -> {
                    return List.of();
                }
            }
        }
        if (args.length == 3 && args[0].equalsIgnoreCase("send")) {
            List<String> names = new ArrayList<>();
            for (Player online : Bukkit.getOnlinePlayers()) {
                names.add(online.getName());
            }
            return prefixMatch(names, args[2]);
        }
        if (args.length == 3 && args[0].equalsIgnoreCase("setstyle")) {
            return prefixMatch(List.of("none", "nether", "tint"), args[2]);
        }
        if (args.length == 3 && (args[0].equalsIgnoreCase("setcolour") || args[0].equalsIgnoreCase("setcolor"))) {
            return prefixMatch(new ArrayList<>(ArgbColours.names()), args[2]);
        }
        if (args.length == 3 && args[0].equalsIgnoreCase("setserver")) {
            return prefixMatch(compassServerIds(), args[2]);
        }
        return List.of();
    }

    private static List<String> compassServerIds() {
        List<String> serverIds = new ArrayList<>();
        for (var entry : ConfigurationManager.getCompass().getServers()) {
            serverIds.add(entry.id());
        }
        return serverIds;
    }

    private static List<String> prefixMatch(List<String> options, String prefix) {
        List<String> result = new ArrayList<>();
        String lower = prefix.toLowerCase(java.util.Locale.ROOT);
        for (String option : options) {
            if (option.toLowerCase(java.util.Locale.ROOT).startsWith(lower)) {
                result.add(option);
            }
        }
        return result;
    }
}
