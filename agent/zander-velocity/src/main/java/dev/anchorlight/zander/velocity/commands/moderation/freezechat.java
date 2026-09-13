package dev.anchorlight.zander.velocity.commands.moderation;

import com.velocitypowered.api.command.CommandSource;
import com.velocitypowered.api.command.SimpleCommand;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import dev.anchorlight.zander.velocity.ZanderVelocityMain;
import dev.anchorlight.zander.velocity.util.ChatFreezeManager;

public class freezechat implements SimpleCommand {

    @Override
    public void execute(final Invocation invocation) {
        CommandSource source = invocation.source();

        // Check permission
        if (!source.hasPermission("zander.moderation.chat.freeze")) {
            source.sendMessage(Component.text("You do not have permission to use this command.")
                    .color(NamedTextColor.RED));
            return;
        }

        // Toggle chat freeze state
        boolean isNowFrozen = !ChatFreezeManager.isChatFrozen();
        ChatFreezeManager.setChatFrozen(isNowFrozen);

        // Determine who executed the command
        String senderName = (source instanceof com.velocitypowered.api.proxy.Player)
                ? ((com.velocitypowered.api.proxy.Player) source).getUsername()
                : "Console";

        // Broadcast message about chat freeze state change
        Component message = isNowFrozen
                ? Component.text("Chat has been frozen by " + senderName + ".").color(NamedTextColor.RED)
                : Component.text("Chat has been unfrozen by " + senderName + ".").color(NamedTextColor.GREEN);

        ZanderVelocityMain.proxy.getAllPlayers().forEach(player -> player.sendMessage(message));

        // Confirm action to the sender
        source.sendMessage(Component.text("You have " + (isNowFrozen ? "frozen" : "unfrozen") + " the chat.")
                .color(NamedTextColor.YELLOW));
    }
}
