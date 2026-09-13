package dev.anchorlight.zander.pgm.command;

import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import dev.anchorlight.zander.pgm.ZanderPGMPlugin;

import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.stream.Collectors;

/**
 * Handles {@code /zpgm maptokens} and {@code /zpgm tokens}. Balance
 * management (grant/remove/set/balance/history) lives entirely on
 * zander-web now — the plugin no longer keeps its own copy of the ledger,
 * so those subcommands just point admins at the dashboard. Only match-facing
 * actions (status, clearing a pending override) stay here.
 */
public class MapTokensCommand {

    private static final String PREFIX = "§6[ZanderPGM] §r";
    private static final List<String> ACTIONS = Arrays.asList("status", "clear");
    private static final List<String> DEPRECATED_ACTIONS = Arrays.asList("grant", "remove", "set", "balance", "history");

    private final ZanderPGMPlugin plugin;

    public MapTokensCommand(ZanderPGMPlugin plugin) {
        this.plugin = plugin;
    }

    public void handle(CommandSender sender, String[] args) {
        if (args.length < 2) {
            sender.sendMessage(PREFIX + "§c/zpgm maptokens <status|clear>");
            return;
        }

        String action = args[1].toLowerCase(Locale.ROOT);
        if (DEPRECATED_ACTIONS.contains(action)) {
            sender.sendMessage(PREFIX + "§cMap Token balances are managed on the web dashboard now: "
                    + "Mixed > Map Tokens.");
            return;
        }

        switch (action) {
            case "status" -> status(sender);
            case "clear" -> clear(sender);
            default -> sender.sendMessage(PREFIX + "§c/zpgm maptokens <status|clear>");
        }
    }

    public List<String> tabComplete(String[] args) {
        if (args.length == 2) {
            return filterPrefix(ACTIONS, args[1]);
        }
        return List.of();
    }

    private void status(CommandSender sender) {
        if (!hasPermission(sender, "zanderpgm.maptokens.status")) {
            deny(sender);
            return;
        }
        sender.sendMessage(PREFIX + "Map Tokens: " + (plugin.cfg().mapTokensEnabled ? "enabled" : "disabled"));
        sender.sendMessage(PREFIX + "API sync: " + (plugin.health().isReachable() ? "connected" : "offline"));
        sender.sendMessage(PREFIX + "Pending requests: " + plugin.tokens().pendingCount());
        sender.sendMessage(PREFIX + "Next-map override: " + plugin.rotation().nextMapOverride().orElse("none"));
        sender.sendMessage(PREFIX + "Queue size: " + plugin.queue().size());
        sender.sendMessage(PREFIX + "Player cooldown: " + plugin.cfg().mapTokenPlayerCooldownMinutes + " minutes");
        sender.sendMessage(PREFIX + "Map cooldown: " + plugin.cfg().mapTokenMapCooldownMatches + " matches");
    }

    private void clear(CommandSender sender) {
        if (!hasPermission(sender, "zanderpgm.maptokens.clear")) {
            deny(sender);
            return;
        }
        boolean had = plugin.tokens().clearOverride(actor(sender), source(sender));
        if (had) {
            sender.sendMessage(PREFIX + "Cleared pending Map Token next-map override.");
        } else {
            sender.sendMessage(PREFIX + "There was no pending Map Token next-map override.");
        }
    }

    private static boolean hasPermission(CommandSender sender, String permission) {
        return !(sender instanceof Player) || sender.hasPermission(permission);
    }

    private static void deny(CommandSender sender) {
        sender.sendMessage(PREFIX + "§cYou do not have permission.");
    }

    private static String actor(CommandSender sender) {
        return sender.getName();
    }

    private static String source(CommandSender sender) {
        return sender instanceof Player ? "ADMIN_COMMAND" : "CONSOLE";
    }

    private static List<String> filterPrefix(List<String> values, String prefix) {
        String lower = prefix.toLowerCase(Locale.ROOT);
        return values.stream()
                .filter(value -> value.startsWith(lower))
                .collect(Collectors.toList());
    }
}
