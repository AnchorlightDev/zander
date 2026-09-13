package dev.anchorlight.zander.pgm.command;

import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import dev.anchorlight.zander.pgm.ZanderPGMPlugin;
import dev.anchorlight.zander.pgm.voting.MapVote;
import dev.anchorlight.zander.pgm.voting.MapVoteOption;

import java.util.Map;

/** {@code /mapvote} — show the current vote and live tally. */
public class MapVoteCommand implements CommandExecutor {

    private final ZanderPGMPlugin plugin;

    public MapVoteCommand(ZanderPGMPlugin plugin) {
        this.plugin = plugin;
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        MapVote vote = plugin.votes().current();
        if (vote == null || !vote.active) {
            sender.sendMessage("§eThere is no active map vote.");
            return true;
        }
        Map<Integer, Integer> tally = vote.tally();
        sender.sendMessage("§6[Mixed] §eCurrent map vote:");
        for (MapVoteOption o : vote.options) {
            String votes = plugin.cfg().showLiveResults ? " §7(" + tally.getOrDefault(o.number, 0) + ")" : "";
            sender.sendMessage("  §b" + o.number + ") §f" + o.mapName + votes);
        }
        return true;
    }
}
