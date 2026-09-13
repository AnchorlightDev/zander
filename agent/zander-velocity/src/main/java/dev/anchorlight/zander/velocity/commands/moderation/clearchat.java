package dev.anchorlight.zander.velocity.commands.moderation;

import com.velocitypowered.api.command.CommandSource;
import com.velocitypowered.api.command.SimpleCommand;
import com.velocitypowered.api.proxy.Player;
import com.velocitypowered.api.proxy.server.RegisteredServer;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;

import java.util.Optional;

public class clearchat implements SimpleCommand {
    @Override
    public void execute(final Invocation invocation) {
        CommandSource source = invocation.source();

        // Check permission
        if (!source.hasPermission("zander.moderation.chat.clear")) {
            source.sendMessage(Component.text("You do not have permission to use this command.")
                    .color(NamedTextColor.RED));
            return;
        }

        // Get the server the command source is on (if it's a player)
        Optional<RegisteredServer> serverOptional = (source instanceof Player player)
                ? player.getCurrentServer().map(serverConnection -> serverConnection.getServer())
                : Optional.empty();

        if (serverOptional.isEmpty()) {
            source.sendMessage(Component.text("You must be on a server to use this command.")
                    .color(NamedTextColor.RED));
            return;
        }

        RegisteredServer targetServer = serverOptional.get();
        String senderName = (source instanceof Player) ? ((Player) source).getUsername() : "Console";

        // Send 150 empty messages to all players on the server
        targetServer.getPlayersConnected().forEach(player -> {
            for (int i = 0; i < 150; i++) {
                player.sendMessage(Component.text(" "));
            }
            player.sendMessage(Component.text("Chat has been cleared by " + senderName + ".")
                    .color(NamedTextColor.YELLOW));
        });

        // Confirmation message
        source.sendMessage(Component.text("Chat cleared for this server by " + senderName + ".")
                .color(NamedTextColor.GREEN));
    }
}
