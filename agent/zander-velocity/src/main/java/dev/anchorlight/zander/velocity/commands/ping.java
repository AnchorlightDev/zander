package dev.anchorlight.zander.velocity.commands;

import com.velocitypowered.api.command.CommandSource;
import com.velocitypowered.api.command.SimpleCommand;
import com.velocitypowered.api.proxy.Player;
import lombok.NonNull;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;

public class ping implements SimpleCommand {

    @Override
    public void execute(@NonNull Invocation invocation) {
        CommandSource source = invocation.source();

        // Check if the source is a player
        if (source instanceof Player) {
            Player player = (Player) source;
            long ping = player.getPing();  // getPing() returns a long

            // Send the ping message to the player
            Component message = Component.text("Your ping is: ")
                    .append(Component.text(ping).color(NamedTextColor.GREEN));

            player.sendMessage(message);
        } else {
            source.sendMessage(Component.text("This command can only be used by players.").color(NamedTextColor.RED));
        }
    }
}