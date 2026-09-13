package dev.anchorlight.zander.hub.commands;

import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import org.jetbrains.annotations.NotNull;


public class fly implements CommandExecutor {
    @Override
    public boolean onCommand(@NotNull CommandSender sender, @NotNull Command cmd, @NotNull String s, String[] args) {
        if (!(sender instanceof Player)) {
            sender.sendMessage("You must be a player to use this command.");
            return true;
        }

        Player player = (Player) sender;

        if (sender.hasPermission("zander.hub.fly")) {
            toggleUserFly(player);
        } else {
            player.sendMessage(Component.text("You must be a donator to use this feature.", NamedTextColor.RED));
        }
        return true;
    }

    private void toggleUserFly(@NotNull Player player) {
        boolean flyable = player.getAllowFlight();

        player.setAllowFlight(!flyable);
        player.setFlying(!flyable);
        player.sendMessage(Component.text("You can " + (!flyable ? "now" : "no longer") + " fly.", NamedTextColor.GREEN));
    }
}
