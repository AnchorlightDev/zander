package dev.anchorlight.zander.velocity.commands;

import com.velocitypowered.api.command.CommandSource;
import com.velocitypowered.api.command.SimpleCommand;
import com.velocitypowered.api.proxy.Player;
import lombok.NonNull;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import dev.anchorlight.zander.velocity.ZanderVelocityMain;
import dev.anchorlight.zander.velocity.util.messaging.PrivateMessageService;

public class togglemessages implements SimpleCommand {

    private static final String PERMISSION = "zander.command.togglemessages";
    private final PrivateMessageService messageService = ZanderVelocityMain.getPrivateMessageService();

    @Override
    public void execute(@NonNull Invocation invocation) {
        CommandSource source = invocation.source();
        if (!(source instanceof Player player)) {
            source.sendMessage(Component.text("This command can only be used by players.").color(NamedTextColor.RED));
            return;
        }
        if (!player.hasPermission(PERMISSION)) {
            player.sendMessage(Component.text("You do not have permission to use this command.").color(NamedTextColor.RED));
            return;
        }
        boolean currentlyDisabled = messageService.isMessagesDisabled(player.getUniqueId());
        messageService.setMessagesDisabled(player.getUniqueId(), !currentlyDisabled);
        if (currentlyDisabled) {
            player.sendMessage(Component.text("Private messages are now enabled.").color(NamedTextColor.GREEN));
        } else {
            player.sendMessage(Component.text("Private messages are now disabled.").color(NamedTextColor.YELLOW));
        }
    }
}
