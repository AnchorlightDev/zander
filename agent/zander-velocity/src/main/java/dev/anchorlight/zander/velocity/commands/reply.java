package dev.anchorlight.zander.velocity.commands;

import com.velocitypowered.api.command.CommandSource;
import com.velocitypowered.api.command.SimpleCommand;
import com.velocitypowered.api.proxy.Player;
import lombok.NonNull;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import dev.anchorlight.zander.velocity.ZanderVelocityMain;
import dev.anchorlight.zander.velocity.util.messaging.MessageDisplayNameResolver;
import dev.anchorlight.zander.velocity.util.messaging.PrivateMessageService;

import java.util.Arrays;
import java.util.Optional;
import java.util.UUID;

public class reply implements SimpleCommand {

    private static final String PERMISSION = "zander.command.reply";
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
        String[] args = invocation.arguments();
        if (args.length < 1) {
            player.sendMessage(Component.text("Usage: /r <message...>").color(NamedTextColor.RED));
            return;
        }

        Optional<UUID> lastTarget = messageService.getLastConversation(player.getUniqueId());
        if (lastTarget.isEmpty()) {
            player.sendMessage(Component.text("No one to reply to.").color(NamedTextColor.RED));
            return;
        }

        Optional<Player> targetOpt = ZanderVelocityMain.getProxy().getPlayer(lastTarget.get());
        if (targetOpt.isEmpty()) {
            messageService.clearLastConversation(player.getUniqueId());
            player.sendMessage(Component.text("That player is offline or not found.").color(NamedTextColor.RED));
            return;
        }

        Player target = targetOpt.get();
        if (target.getUniqueId().equals(player.getUniqueId())) {
            player.sendMessage(Component.text("You cannot message yourself.").color(NamedTextColor.RED));
            return;
        }
        if (messageService.isMessagesDisabled(target.getUniqueId())) {
            player.sendMessage(Component.text("That player is not accepting private messages.").color(NamedTextColor.RED));
            return;
        }
        if (messageService.isIgnoring(target.getUniqueId(), player.getUniqueId())) {
            player.sendMessage(Component.text("You cannot message that player.").color(NamedTextColor.RED));
            return;
        }

        String message = String.join(" ", Arrays.copyOfRange(args, 0, args.length));
        Component senderMessage = Component.text("To ").color(NamedTextColor.GRAY)
                .append(MessageDisplayNameResolver.resolve(target))
                .append(Component.text(": ").color(NamedTextColor.GRAY))
                .append(Component.text(message).color(NamedTextColor.WHITE));
        Component targetMessage = Component.text("From ").color(NamedTextColor.GRAY)
                .append(MessageDisplayNameResolver.resolve(player))
                .append(Component.text(": ").color(NamedTextColor.GRAY))
                .append(Component.text(message).color(NamedTextColor.WHITE));

        player.sendMessage(senderMessage);
        target.sendMessage(targetMessage);

        messageService.updateNameCache(player.getUniqueId(), player.getUsername());
        messageService.updateNameCache(target.getUniqueId(), target.getUsername());
        messageService.setLastConversation(player.getUniqueId(), target.getUniqueId());
    }
}
