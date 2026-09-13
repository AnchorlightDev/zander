package dev.anchorlight.zander.velocity.commands.moderation;

import com.velocitypowered.api.command.CommandSource;
import com.velocitypowered.api.command.SimpleCommand;
import com.velocitypowered.api.proxy.Player;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.format.TextDecoration;
import net.kyori.adventure.text.serializer.legacy.LegacyComponentSerializer;
import dev.anchorlight.zander.velocity.ZanderVelocityMain;

import java.util.Collection;

public class alert implements SimpleCommand {

    @Override
    public void execute(final Invocation invocation) {
        CommandSource source = invocation.source();
        String[] args = invocation.arguments();

        if (!source.hasPermission("zander.moderation.alert")) {
            source.sendMessage(Component.text("You do not have permission to use this command.")
                    .color(NamedTextColor.RED));
            return;
        }

        if (args.length == 0) {
            source.sendMessage(Component.text("Usage: /alert <message>").color(NamedTextColor.RED));
            return;
        }

        String raw = String.join(" ", args);
        Component message = Component.text()
                .append(Component.text("[!] ").color(NamedTextColor.RED).decorate(TextDecoration.BOLD))
                .append(LegacyComponentSerializer.legacyAmpersand().deserialize(raw))
                .build();

        Collection<Player> players = ZanderVelocityMain.getProxy().getAllPlayers();
        players.forEach(player -> player.sendMessage(message));

        String senderName = (source instanceof Player) ? ((Player) source).getUsername() : "Console";
        source.sendMessage(Component.text("Alert sent to " + players.size() + " player(s).").color(NamedTextColor.GREEN));
        ZanderVelocityMain.getLogger().info("[Alert] {} broadcasted: {}", senderName, raw);
    }
}
