package dev.anchorlight.zander.addon.commands;

import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import org.bukkit.Bukkit;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import org.jetbrains.annotations.NotNull;
import dev.anchorlight.zander.addon.service.FreezeService;

public class FreezeCommand implements CommandExecutor {
    private final FreezeService freezeService;

    public FreezeCommand(FreezeService freezeService) {
        this.freezeService = freezeService;
    }

    @Override
    public boolean onCommand(@NotNull CommandSender sender, @NotNull Command command, @NotNull String label, @NotNull String[] args) {
        if (!sender.hasPermission("zander.command.freeze")) {
            sender.sendMessage(Component.text("You do not have permission to use this command.", NamedTextColor.RED));
            return true;
        }

        if (args.length == 0) {
            sender.sendMessage(Component.text("Usage: /freeze <player>", NamedTextColor.RED));
            return true;
        }

        Player target = Bukkit.getPlayer(args[0]);
        if (target == null) {
            sender.sendMessage(Component.text("Player not found.", NamedTextColor.RED));
            return true;
        }

        if (target.hasPermission("zander.command.freeze.bypass") && sender instanceof Player) {
            sender.sendMessage(Component.text("You cannot freeze this player.", NamedTextColor.RED));
            return true;
        }

        boolean frozen = freezeService.toggleFreeze(target.getUniqueId());

        if (frozen) {
            target.closeInventory();
            target.sendMessage(Component.text("You have been frozen by a moderator!", NamedTextColor.RED));
            sender.sendMessage(Component.text("You have frozen " + target.getName() + ".", NamedTextColor.GREEN));
        } else {
            target.sendMessage(Component.text("You have been unfrozen by a moderator!", NamedTextColor.GREEN));
            sender.sendMessage(Component.text("You have unfrozen " + target.getName() + ".", NamedTextColor.GREEN));
        }

        return true;
    }
}
