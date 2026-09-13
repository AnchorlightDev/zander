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
import dev.anchorlight.stonelib.vanish.proxy.ProxyVanishStatus;

import java.util.Arrays;
import java.util.List;
import java.util.Optional;

public class message implements SimpleCommand {

    private static final String PERMISSION = "zander.command.message";
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
        if (args.length < 2) {
            player.sendMessage(Component.text("Usage: /msg <player> <message...>").color(NamedTextColor.RED));
            return;
        }
        String targetName = args[0];
        if (targetName.equalsIgnoreCase(player.getUsername())) {
            player.sendMessage(Component.text("You cannot message yourself.").color(NamedTextColor.RED));
            return;
        }
        Optional<Player> targetOpt = findOnlinePlayer(targetName);
        if (targetOpt.isEmpty()) {
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

        String message = String.join(" ", Arrays.copyOfRange(args, 1, args.length));
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

    @Override
    public List<String> suggest(@NonNull Invocation invocation) {
        String[] args = invocation.arguments();
        if (args.length <= 1) {
            String prefix = args.length == 1 ? args[0].toLowerCase() : "";
            return ZanderVelocityMain.getProxy().getAllPlayers().stream()
                    .filter(player -> !ProxyVanishStatus.isVanished(player))
                    .map(Player::getUsername)
                    .filter(name -> name.toLowerCase().startsWith(prefix))
                    .sorted(String.CASE_INSENSITIVE_ORDER)
                    .toList();
        }
        return List.of();
    }

    private Optional<Player> findOnlinePlayer(String name) {
        Optional<Player> direct = ZanderVelocityMain.getProxy().getPlayer(name);
        if (direct.isPresent()) {
            return direct;
        }
        return ZanderVelocityMain.getProxy().getAllPlayers().stream()
                .filter(player -> player.getUsername().equalsIgnoreCase(name))
                .findFirst();
    }
}
