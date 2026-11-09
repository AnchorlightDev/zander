package dev.anchorlight.zander.velocity.commands;

import com.jayway.jsonpath.DocumentContext;
import com.jayway.jsonpath.JsonPath;
import com.velocitypowered.api.command.CommandSource;
import com.velocitypowered.api.command.SimpleCommand;
import com.velocitypowered.api.proxy.Player;
import dev.dejvokep.boostedyaml.route.Route;
import dev.anchorlight.stonelib.http.Request;
import dev.anchorlight.zander.velocity.ZanderVelocityMain;
import dev.anchorlight.zander.velocity.model.nickname.NicknameClear;
import dev.anchorlight.zander.velocity.model.nickname.NicknameSet;
import dev.anchorlight.zander.velocity.util.nickname.NicknameCache;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.minimessage.MiniMessage;

import java.util.List;

/**
 * /nick &lt;name&gt;  — set or change your nickname
 * /nick off       — remove your nickname
 *
 * All rules (permission, punishment, lockout, cooldown, validation,
 * impersonation) are enforced by the Zander API; this command just relays the
 * outcome and refreshes the display on success.
 */
public class nick implements SimpleCommand {

    private static final MiniMessage MM = MiniMessage.miniMessage();

    @Override
    public void execute(final Invocation invocation) {
        CommandSource source = invocation.source();
        String[] args = invocation.arguments();

        if (!(source instanceof Player)) {
            source.sendMessage(Component.text("Only players can use this command.").color(NamedTextColor.RED));
            return;
        }
        Player player = (Player) source;

        if (args.length == 0) {
            player.sendMessage(MM.deserialize(
                    "<gray>Usage: <white>/nick <name></white> or <white>/nick off</white> to remove it.</gray>"));
            return;
        }

        String base = ZanderVelocityMain.getConfig().getString(Route.from("BaseAPIURL"));
        String apiKey = ZanderVelocityMain.getConfig().getString(Route.from("APIKey"));

        boolean clearing = args[0].equalsIgnoreCase("off") || args[0].equalsIgnoreCase("clear")
                || args[0].equalsIgnoreCase("remove");

        ZanderVelocityMain.getProxy().getScheduler()
                .buildTask(ZanderVelocityMain.getInstance(), () -> {
                    try {
                        String url = base + (clearing ? "/nickname/clear" : "/nickname/set");
                        String body = clearing
                                ? NicknameClear.builder().uuid(player.getUniqueId()).build().toString()
                                : NicknameSet.builder()
                                        .uuid(player.getUniqueId())
                                        .name(args[0])
                                        .build()
                                        .toString();

                        Request req = Request.builder()
                                .setURL(url)
                                .setMethod(Request.Method.POST)
                                .addHeader("x-access-token", apiKey)
                                .setRequestBody(body)
                                .build();

                        String json = req.execute().getBody();
                        DocumentContext doc = JsonPath.parse(json);
                        boolean success = Boolean.TRUE.equals(readBool(doc, "$.success"));
                        String message = readString(doc, "$.message");

                        if (!success) {
                            player.sendMessage(MM.deserialize("<red>" + escape(message != null ? message
                                    : "That nickname isn't allowed.") + "</red>"));
                            return;
                        }

                        // Refresh the cache + tab list for everyone, then confirm.
                        NicknameCache.refreshAsync(player);
                        if (clearing) {
                            player.sendMessage(MM.deserialize("<green>Your nickname has been removed.</green>"));
                        } else {
                            player.sendMessage(MM.deserialize(
                                    "<green>Your nickname is now <white>~" + escape(args[0]) + "</white>.</green>"));
                        }
                    } catch (Exception e) {
                        player.sendMessage(MM.deserialize(
                                "<red>Could not reach the nickname service. Please try again.</red>"));
                        ZanderVelocityMain.getLogger().error("Nickname command failed for {}", player.getUsername(), e);
                    }
                }).schedule();
    }

    @Override
    public List<String> suggest(final Invocation invocation) {
        if (invocation.arguments().length <= 1) {
            return List.of("off");
        }
        return List.of();
    }

    private static String escape(String input) {
        return input == null ? "" : input.replace("<", "\\<").replace(">", "\\>");
    }

    private static Boolean readBool(DocumentContext doc, String path) {
        try {
            return doc.read(path, Boolean.class);
        } catch (Exception ignored) {
            return null;
        }
    }

    private static String readString(DocumentContext doc, String path) {
        try {
            Object v = doc.read(path);
            return v == null ? null : String.valueOf(v);
        } catch (Exception ignored) {
            return null;
        }
    }
}
