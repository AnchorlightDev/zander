package dev.anchorlight.zander.velocity.commands;

import com.velocitypowered.api.command.CommandSource;
import com.velocitypowered.api.command.SimpleCommand;
import com.velocitypowered.api.proxy.Player;
import lombok.NonNull;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import dev.anchorlight.zander.velocity.ZanderVelocityMain;
import dev.anchorlight.zander.velocity.util.messaging.PrivateMessageService;
import dev.anchorlight.stonelib.vanish.proxy.ProxyVanishStatus;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;
import java.util.stream.Stream;
import java.util.Set;
import java.util.UUID;

public class ignore implements SimpleCommand {

    private static final String BASE_PERMISSION = "zander.command.ignore";
    private static final String ADD_PERMISSION = "zander.command.ignore.add";
    private static final String REMOVE_PERMISSION = "zander.command.ignore.remove";
    private static final String LIST_PERMISSION = "zander.command.ignore.list";
    private static final int MAX_LIST_SIZE = 10;
    private final PrivateMessageService messageService = ZanderVelocityMain.getPrivateMessageService();

    @Override
    public void execute(@NonNull Invocation invocation) {
        CommandSource source = invocation.source();
        if (!(source instanceof Player player)) {
            source.sendMessage(Component.text("This command can only be used by players.").color(NamedTextColor.RED));
            return;
        }
        if (!player.hasPermission(BASE_PERMISSION)) {
            player.sendMessage(Component.text("You do not have permission to use this command.").color(NamedTextColor.RED));
            return;
        }
        String[] args = invocation.arguments();
        if (args.length == 0) {
            player.sendMessage(Component.text("Usage: /ignore <add|remove|list> [player]").color(NamedTextColor.RED));
            return;
        }

        String subcommand = args[0].toLowerCase();
        switch (subcommand) {
            case "add" -> handleAdd(player, args);
            case "remove" -> handleRemove(player, args);
            case "list" -> handleList(player);
            default -> player.sendMessage(Component.text("Usage: /ignore <add|remove|list> [player]").color(NamedTextColor.RED));
        }
    }

    @Override
    public List<String> suggest(@NonNull Invocation invocation) {
        String[] args = invocation.arguments();
        if (args.length <= 1) {
            String prefix = args.length == 1 ? args[0].toLowerCase() : "";
            return Stream.of("add", "remove", "list")
                    .filter(option -> option.startsWith(prefix))
                    .sorted(String.CASE_INSENSITIVE_ORDER)
                    .toList();
        }
        if (args.length == 2 && ("add".equalsIgnoreCase(args[0]) || "remove".equalsIgnoreCase(args[0]))) {
            String prefix = args[1].toLowerCase();
            return ZanderVelocityMain.getProxy().getAllPlayers().stream()
                    .filter(player -> !ProxyVanishStatus.isVanished(player))
                    .map(Player::getUsername)
                    .filter(name -> name.toLowerCase().startsWith(prefix))
                    .sorted(String.CASE_INSENSITIVE_ORDER)
                    .toList();
        }
        return List.of();
    }

    private void handleAdd(Player player, String[] args) {
        if (!player.hasPermission(ADD_PERMISSION)) {
            player.sendMessage(Component.text("You do not have permission to use this command.").color(NamedTextColor.RED));
            return;
        }
        if (args.length < 2) {
            player.sendMessage(Component.text("Usage: /ignore add <player>").color(NamedTextColor.RED));
            return;
        }
        String targetName = args[1];
        if (targetName.equalsIgnoreCase(player.getUsername())) {
            player.sendMessage(Component.text("You cannot ignore yourself.").color(NamedTextColor.RED));
            return;
        }
        Optional<UUID> targetUuid = messageService.resolveUuid(targetName, ZanderVelocityMain.getProxy());
        if (targetUuid.isEmpty()) {
            player.sendMessage(Component.text("Player not found.").color(NamedTextColor.RED));
            return;
        }
        if (targetUuid.get().equals(player.getUniqueId())) {
            player.sendMessage(Component.text("You cannot ignore yourself.").color(NamedTextColor.RED));
            return;
        }
        boolean added = messageService.addIgnore(player.getUniqueId(), targetUuid.get());
        String displayName = messageService.getCachedName(targetUuid.get()).orElse(targetName);
        if (!added) {
            player.sendMessage(Component.text("You are already ignoring " + displayName + ".").color(NamedTextColor.YELLOW));
            return;
        }
        player.sendMessage(Component.text("You are now ignoring " + displayName + ".").color(NamedTextColor.GREEN));
    }

    private void handleRemove(Player player, String[] args) {
        if (!player.hasPermission(REMOVE_PERMISSION)) {
            player.sendMessage(Component.text("You do not have permission to use this command.").color(NamedTextColor.RED));
            return;
        }
        if (args.length < 2) {
            player.sendMessage(Component.text("Usage: /ignore remove <player>").color(NamedTextColor.RED));
            return;
        }
        String targetName = args[1];
        Optional<UUID> targetUuid = messageService.resolveUuid(targetName, ZanderVelocityMain.getProxy());
        if (targetUuid.isEmpty()) {
            player.sendMessage(Component.text("Player not found.").color(NamedTextColor.RED));
            return;
        }
        boolean removed = messageService.removeIgnore(player.getUniqueId(), targetUuid.get());
        String displayName = messageService.getCachedName(targetUuid.get()).orElse(targetName);
        if (!removed) {
            player.sendMessage(Component.text(displayName + " is not on your ignore list.").color(NamedTextColor.YELLOW));
            return;
        }
        player.sendMessage(Component.text("You are no longer ignoring " + displayName + ".").color(NamedTextColor.GREEN));
    }

    private void handleList(Player player) {
        if (!player.hasPermission(LIST_PERMISSION)) {
            player.sendMessage(Component.text("You do not have permission to use this command.").color(NamedTextColor.RED));
            return;
        }
        Set<UUID> ignores = messageService.getIgnoreList(player.getUniqueId());
        if (ignores.isEmpty()) {
            player.sendMessage(Component.text("You are not ignoring anyone.").color(NamedTextColor.YELLOW));
            return;
        }
        List<String> names = new ArrayList<>();
        for (UUID uuid : ignores) {
            names.add(messageService.getCachedName(uuid).orElse(uuid.toString()));
        }
        names.sort(Comparator.comparing(String::toLowerCase));
        int total = names.size();
        List<String> displayNames = names.subList(0, Math.min(MAX_LIST_SIZE, total));
        StringBuilder builder = new StringBuilder();
        builder.append("Ignored players (").append(total).append("): ")
                .append(String.join(", ", displayNames));
        if (total > MAX_LIST_SIZE) {
            builder.append(" and ").append(total - MAX_LIST_SIZE).append(" more...");
        }
        player.sendMessage(Component.text(builder.toString()).color(NamedTextColor.GRAY));
    }
}
