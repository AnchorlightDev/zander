package dev.anchorlight.zander.pgm.command;

import org.bukkit.Bukkit;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.command.TabCompleter;
import dev.anchorlight.zander.pgm.ZanderPGMPlugin;
import dev.anchorlight.zander.pgm.config.ZanderPGMConfig;
import dev.anchorlight.zander.pgm.pgm.MatchIdentityService;

import java.util.Arrays;
import java.util.List;
import java.util.stream.Collectors;

/** Admin command {@code /zpgm} with status, reload, reconnect, flush, debug, vote, maptokens, rating. */
public class ZpgmCommand implements CommandExecutor, TabCompleter {

    private static final List<String> ROOT = Arrays.asList(
            "status", "reload", "reconnect", "flush", "debug", "vote", "maptokens", "tokens", "rating");

    private final ZanderPGMPlugin plugin;
    private final MapTokensCommand mapTokensCommand;

    public ZpgmCommand(ZanderPGMPlugin plugin) {
        this.plugin = plugin;
        this.mapTokensCommand = new MapTokensCommand(plugin);
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (!sender.hasPermission("zanderpgm.admin")) {
            sender.sendMessage("Â§cYou do not have permission.");
            return true;
        }
        if (args.length == 0) {
            sender.sendMessage("Â§6/zpgm Â§7<" + String.join("|", ROOT) + ">");
            return true;
        }
        switch (args[0].toLowerCase()) {
            case "status" -> status(sender);
            case "reload" -> {
                plugin.reloadPluginConfig();
                sender.sendMessage("Â§aConfig reloaded and connections refreshed.");
            }
            case "reconnect" -> {
                plugin.ws().reconnect();
                sender.sendMessage("Â§aReconnecting WebSocket...");
            }
            case "flush" -> {
                plugin.flushQueue();
                sender.sendMessage("Â§aFlushing queued events...");
            }
            case "debug" -> debug(sender);
            case "vote" -> vote(sender, args);
            case "maptokens", "tokens" -> maptokens(sender, args);
            case "rating" -> rating(sender, args);
            default -> sender.sendMessage("Â§cUnknown subcommand.");
        }
        return true;
    }

    private void status(CommandSender sender) {
        ZanderPGMConfig cfg = plugin.cfg();
        MatchIdentityService.Identity id = plugin.identity().current();
        sender.sendMessage("Â§6=== ZanderPGM Status ===");
        sender.sendMessage("Â§7Server ID: Â§f" + cfg.serverId);
        sender.sendMessage("Â§7API base: Â§f" + cfg.baseUrl);
        sender.sendMessage("Â§7REST reachable: " + yn(plugin.health().isReachable()));
        sender.sendMessage("Â§7WebSocket: " + yn(plugin.ws().isConnected()));
        sender.sendMessage("Â§7Queued events: Â§f" + plugin.queue().size()
                + " Â§7(dropped: " + plugin.queue().droppedCount() + ")");
        sender.sendMessage("Â§7Current match: Â§f" + (id != null ? id.matchId : "none"));
        sender.sendMessage("Â§7Current map: Â§f" + (id != null ? id.mapName : "none"));
        sender.sendMessage("Â§7Players online: Â§f" + Bukkit.getOnlinePlayers().size());
        String features = cfg.features.entrySet().stream()
                .filter(java.util.Map.Entry::getValue)
                .map(java.util.Map.Entry::getKey)
                .collect(Collectors.joining(", "));
        sender.sendMessage("Â§7Enabled features: Â§f" + features);
    }

    private void debug(CommandSender sender) {
        MatchIdentityService.Identity id = plugin.identity().current();
        if (id == null) {
            sender.sendMessage("Â§eNo match loaded.");
            return;
        }
        sender.sendMessage("Â§6=== Match Debug ===");
        sender.sendMessage("Â§7Match ID: Â§f" + id.matchId);
        sender.sendMessage("Â§7Map: Â§f" + id.mapName + " Â§7(" + id.mapKey + ") v" + id.mapVersion);
        sender.sendMessage("Â§7Tracked players: Â§f" + plugin.stats().allPlayers().size());
        sender.sendMessage("Â§7Players online: Â§f" + Bukkit.getOnlinePlayers().size());
    }

    private void vote(CommandSender sender, String[] args) {
        if (args.length < 2) {
            sender.sendMessage("Â§c/zpgm vote <start|end|status|cancel>");
            return;
        }
        switch (args[1].toLowerCase()) {
            case "start" -> {
                if (plugin.votes().start() != null) {
                    sender.sendMessage("Â§aMap vote started.");
                } else {
                    sender.sendMessage("Â§cCould not start a vote (disabled or already active).");
                }
            }
            case "end" -> {
                plugin.votes().end();
                sender.sendMessage("Â§aMap vote ended.");
            }
            case "cancel" -> {
                plugin.votes().cancel("admin");
                sender.sendMessage("Â§aMap vote cancelled.");
            }
            case "status" -> sender.sendMessage("Â§7Vote active: " + yn(plugin.votes().isActive()));
            default -> sender.sendMessage("Â§c/zpgm vote <start|end|status|cancel>");
        }
    }

    private void maptokens(CommandSender sender, String[] args) {
        mapTokensCommand.handle(sender, args);
    }

    private void rating(CommandSender sender, String[] args) {
        if (args.length >= 2 && args[1].equalsIgnoreCase("reset")) {
            plugin.ratings().reset();
            sender.sendMessage("Â§aRating session reset.");
            return;
        }
        sender.sendMessage("Â§c/zpgm rating reset <map>");
    }

    private String yn(boolean b) {
        return b ? "Â§ayes" : "Â§cno";
    }

    @Override
    public List<String> onTabComplete(CommandSender sender, Command command, String alias, String[] args) {
        if (args.length == 1) {
            return ROOT.stream().filter(s -> s.startsWith(args[0].toLowerCase())).collect(Collectors.toList());
        }
        if (args.length == 2 && args[0].equalsIgnoreCase("vote")) {
            return Arrays.asList("start", "end", "status", "cancel");
        }
        if (args.length >= 2 && (args[0].equalsIgnoreCase("maptokens") || args[0].equalsIgnoreCase("tokens"))) {
            return mapTokensCommand.tabComplete(args);
        }
        return List.of();
    }
}
