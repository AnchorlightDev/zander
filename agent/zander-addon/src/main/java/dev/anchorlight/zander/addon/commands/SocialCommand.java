package dev.anchorlight.zander.addon.commands;

import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import org.jetbrains.annotations.NotNull;
import dev.anchorlight.zander.addon.ZanderAddonMain;
import dev.anchorlight.zander.addon.gui.SocialGUI;

public class SocialCommand implements CommandExecutor {
    private final ZanderAddonMain plugin;
    private final SocialGUI socialGUI;

    public SocialCommand(ZanderAddonMain plugin, SocialGUI socialGUI) {
        this.plugin = plugin;
        this.socialGUI = socialGUI;
    }

    @Override
    public boolean onCommand(@NotNull CommandSender sender, @NotNull Command command, @NotNull String label, @NotNull String[] args) {
        if (!(sender instanceof Player player)) {
            sender.sendMessage(Component.text("This command can only be used by players.", NamedTextColor.RED));
            return true;
        }

        socialGUI.open(player);
        return true;
    }
}
