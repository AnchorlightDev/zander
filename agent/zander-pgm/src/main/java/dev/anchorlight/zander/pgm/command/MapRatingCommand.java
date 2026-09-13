package dev.anchorlight.zander.pgm.command;

import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import dev.anchorlight.zander.pgm.ZanderPGMPlugin;
import dev.anchorlight.zander.pgm.rating.MapRatingSession;

/** {@code /maprating} — show the current/last rating prompt and status. */
public class MapRatingCommand implements CommandExecutor {

    private final ZanderPGMPlugin plugin;

    public MapRatingCommand(ZanderPGMPlugin plugin) {
        this.plugin = plugin;
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        MapRatingSession session = plugin.ratings().current();
        if (session == null) {
            sender.sendMessage("§eThere is no map awaiting ratings right now.");
            return true;
        }
        long remaining = Math.max(0, session.windowSeconds
                - (System.currentTimeMillis() - session.startedAt) / 1000L);
        sender.sendMessage("§6[Mixed] §eRate §f" + session.mapName + "§e (1-5): §7/maprate <1-5>");
        sender.sendMessage("§7Ratings so far: " + session.count()
                + " · window closes in " + remaining + "s");
        return true;
    }
}
