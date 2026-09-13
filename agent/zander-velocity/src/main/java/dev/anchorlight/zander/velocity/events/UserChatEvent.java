package dev.anchorlight.zander.velocity.events;

import com.jayway.jsonpath.JsonPath;
import com.velocitypowered.api.event.Subscribe;
import com.velocitypowered.api.event.player.PlayerChatEvent;
import com.velocitypowered.api.proxy.Player;
import dev.dejvokep.boostedyaml.route.Route;
import dev.anchorlight.stonelib.http.Request;
import dev.anchorlight.stonelib.http.Response;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.TextComponent;
import net.kyori.adventure.text.event.HoverEvent;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.minimessage.MiniMessage;
import net.kyori.adventure.text.serializer.legacy.LegacyComponentSerializer;
import dev.anchorlight.zander.velocity.ZanderVelocityMain;
import dev.anchorlight.zander.velocity.model.Filter;
import dev.anchorlight.zander.velocity.model.discord.DiscordChat;

import net.luckperms.api.LuckPermsProvider;
import net.luckperms.api.model.user.User;
import net.luckperms.api.cacheddata.CachedMetaData;
import net.luckperms.api.platform.PlayerAdapter;
import java.util.List;
import java.util.Map;
import java.util.Optional;

public class UserChatEvent {

    private final MiniMessage miniMessage = MiniMessage.miniMessage();

    @Subscribe
    public void UserChatEvent(PlayerChatEvent event) {
        Player player = event.getPlayer();
        String rawMessage = event.getMessage();
        Component originalMessage = Component.text(rawMessage);
        String BaseAPIURL = ZanderVelocityMain.getConfig().getString(Route.from("BaseAPIURL"));
        String APIKey = ZanderVelocityMain.getConfig().getString(Route.from("APIKey"));

        // Filter out commands.
        if (rawMessage.startsWith("/")) return;

        // Pass numeric-only messages through without processing (e.g. QuickShop quantity input)
        if (rawMessage.matches("^[0-9]+$")) return;

        // Check chat for blocked content
        try {
            Filter phrase = Filter.builder()
                    .content(rawMessage)
                    .build();

            Request phraseReq = Request.builder()
                    .setURL(BaseAPIURL + "/filter")
                    .setMethod(Request.Method.POST)
                    .addHeader("x-access-token", APIKey)
                    .setRequestBody(phrase.toString())
                    .build();

            Response phraseRes = phraseReq.execute();
            String phraseJson = phraseRes.getBody();

            Boolean success = JsonPath.parse(phraseJson).read("$.success");
            String phraseCaughtMessage = JsonPath.read(phraseJson, "$.message");

            if (!success) {
                Component builder = Component.text(phraseCaughtMessage).color(NamedTextColor.RED);
                player.sendMessage(builder);
                event.setResult(PlayerChatEvent.ChatResult.denied());
                return;
            } else {
                DiscordChat chat = DiscordChat.builder()
                        .username(player.getUsername())
                        .server(player.getCurrentServer().get().getServer().getServerInfo().getName())
                        .content(rawMessage)
                        .build();

                Request discordChatReq = Request.builder()
                        .setURL(BaseAPIURL + "/discord/chat")
                        .setMethod(Request.Method.POST)
                        .addHeader("x-access-token", String.valueOf(APIKey))
                        .setRequestBody(chat.toString())
                        .build();

                discordChatReq.execute();
            }

            Component formattedMessage = formatChatMessage(player, originalMessage);
            player.getCurrentServer()
                    .map(serverConnection -> serverConnection.getServer())
                    .ifPresentOrElse(
                            server -> server.getPlayersConnected().forEach(target -> target.sendMessage(formattedMessage)),
                            () -> player.sendMessage(formattedMessage)
                    );
            event.setResult(PlayerChatEvent.ChatResult.denied());
        } catch (Exception e) {
            Component builder = Component.text("The chat filter could not be reached at this time, there maybe an issue with the API.").color(NamedTextColor.YELLOW);
            player.sendMessage(builder);
            event.setResult(PlayerChatEvent.ChatResult.denied());
            ZanderVelocityMain.getLogger().error("Chat filter error for player {}", player.getUsername(), e);
        }
    }

    private Component formatChatMessage(Player player, Component originalMessage) {
        LuckPermsMeta metaData = resolveLuckPermsMeta(player).orElse(null);
        String prefix = metaData != null ? metaData.prefix : null;

        TextComponent.Builder builder = Component.text();
        if (prefix != null && !prefix.isBlank()) {
            builder.append(buildRankPrefix(metaData)).append(Component.space());
        }

        return builder
                .append(Component.text(player.getUsername()))
                .append(Component.text(": "))
                .append(originalMessage)
                .build();
    }

    private Component buildRankPrefix(LuckPermsMeta metaData) {
        String prefix = metaData != null ? metaData.prefix : null;
        String rankNameMeta = getMetaValue(metaData, "displayname");
        String rankDescriptionMeta = getMetaValue(metaData, "rank_description");

        String rankName = (rankNameMeta != null && !rankNameMeta.isBlank())
                ? rankNameMeta
                : (prefix != null && !prefix.isBlank() ? prefix : "Member");
        String rankDescription = (rankDescriptionMeta != null && !rankDescriptionMeta.isBlank())
                ? rankDescriptionMeta
                : "No description set for this rank.";

        rankName = stripLegacy(rankName);
        rankDescription = stripLegacy(rankDescription);

        Component prefixComponent = buildPrefixComponent(prefix, rankName);
        Component hoverText = Component.text()
                .append(prefixComponent)
                .append(Component.space())
                .append(Component.text(rankName).color(NamedTextColor.GOLD))
                .append(Component.newline())
                .append(Component.text(rankDescription).color(NamedTextColor.GRAY))
                .build();

        return prefixComponent.hoverEvent(HoverEvent.showText(hoverText));
    }

    private String getMetaValue(LuckPermsMeta metaData, String baseKey) {
        if (metaData == null) {
            return null;
        }
        String scopedKey = null;
        if (metaData.primaryGroup != null && !metaData.primaryGroup.isBlank()) {
            scopedKey = baseKey + "." + metaData.primaryGroup;
        }
        if (scopedKey != null) {
            String scopedValue = metaData.metaValues.get(scopedKey);
            if (scopedValue != null && !scopedValue.isBlank()) {
                return scopedValue;
            }
        }
        String directValue = metaData.metaValues.get(baseKey);
        if (directValue != null && !directValue.isBlank()) {
            return directValue;
        }
        return null;
    }

    private Component buildPrefixComponent(String prefix, String rankName) {
        if (prefix != null && !prefix.isBlank()) {
            return LegacyComponentSerializer.legacyAmpersand().deserialize(prefix);
        }

        String miniMessagePrefix = "<dark_gray>[</dark_gray><yellow>"
                + escapeMiniMessageContent(rankName)
                + "</yellow><dark_gray>]</dark_gray>";
        return miniMessage.deserialize(miniMessagePrefix);
    }

    private String escapeMiniMessageContent(String input) {
        return input.replace("<", "\\<").replace(">", "\\>");
    }

    private String stripLegacy(String input) {
        return input.replaceAll("§.", "").replaceAll("&.", "");
    }

    private Optional<LuckPermsMeta> resolveLuckPermsMeta(Player player) {
        try {
            PlayerAdapter<Player> adapter = LuckPermsProvider.get().getPlayerAdapter(Player.class);
            User user = adapter.getUser(player);
            CachedMetaData metaData = adapter.getMetaData(player);

            String prefix = metaData.getPrefix();
            String primaryGroup = user != null ? user.getPrimaryGroup() : null;
            Map<String, String> flatMeta = flattenMeta(metaData.getMeta());

            return Optional.of(new LuckPermsMeta(prefix, primaryGroup, flatMeta));
        } catch (IllegalStateException ignored) {
            // LuckPerms not installed on this proxy
            return Optional.empty();
        } catch (Exception e) {
            ZanderVelocityMain.getLogger().warn("Failed to resolve LuckPerms meta for {}: {}", player.getUsername(), e.getMessage());
            return Optional.empty();
        }
    }

    private Map<String, String> flattenMeta(Map<String, List<String>> metaMap) {
        Map<String, String> flattened = new java.util.HashMap<>();
        for (Map.Entry<String, List<String>> entry : metaMap.entrySet()) {
            List<String> values = entry.getValue();
            if (values == null) continue;
            for (String value : values) {
                if (value != null && !value.isBlank()) {
                    flattened.put(entry.getKey(), value);
                    break;
                }
            }
        }
        return flattened;
    }

    private static class LuckPermsMeta {
        private final String prefix;
        private final String primaryGroup;
        private final Map<String, String> metaValues;

        private LuckPermsMeta(String prefix, String primaryGroup, Map<String, String> metaValues) {
            this.prefix = prefix;
            this.primaryGroup = primaryGroup;
            this.metaValues = metaValues;
        }
    }
}
