package dev.anchorlight.zander.velocity.commands;

import com.jayway.jsonpath.JsonPath;
import com.velocitypowered.api.command.CommandSource;
import com.velocitypowered.api.command.SimpleCommand;
import com.velocitypowered.api.proxy.Player;
import dev.dejvokep.boostedyaml.route.Route;
import dev.anchorlight.stonelib.http.Request;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.minimessage.MiniMessage;
import dev.anchorlight.zander.velocity.ZanderVelocityMain;
import dev.anchorlight.zander.velocity.model.user.UserCreation;
import dev.anchorlight.zander.velocity.model.user.UserVerifyCode;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class verify implements SimpleCommand {

    private static final MiniMessage MM = MiniMessage.miniMessage();
    private static final Pattern CODE_PATTERN = Pattern.compile("\\b([0-9]{6})\\b");

    @Override
    public void execute(final Invocation invocation) {
        CommandSource source = invocation.source();
        String[] args = invocation.arguments();

        if (!(source instanceof Player)) {
            source.sendMessage(Component.text("Only players can use this command.").color(NamedTextColor.RED));
            return;
        }

        Player player = (Player) source;
        String baseApiUrl = ZanderVelocityMain.getConfig().getString(Route.from("BaseAPIURL"));
        String apiKey = ZanderVelocityMain.getConfig().getString(Route.from("APIKey"));

        if (args.length == 0) {
            // Request a verification code from the API
            ZanderVelocityMain.getProxy().getScheduler()
                    .buildTask(ZanderVelocityMain.getInstance(), () -> {
                        try {
                            UserCreation body = UserCreation.builder()
                                    .username(player.getUsername())
                                    .uuid(player.getUniqueId())
                                    .build();

                            Request req = Request.builder()
                                    .setURL(baseApiUrl + "/user/verify")
                                    .setMethod(Request.Method.POST)
                                    .addHeader("x-access-token", apiKey)
                                    .setRequestBody(body.toString())
                                    .build();

                            String json = req.execute().getBody();
                            boolean success = JsonPath.read(json, "$.success");
                            String message = JsonPath.read(json, "$.message");

                            if (success) {
                                String code = extractCode(message);
                                player.sendMessage(buildCodeMessage(code));
                            } else if (message != null && message.toLowerCase().contains("already")) {
                                player.sendMessage(MM.deserialize(
                                        "<green>Your account is already linked! Head to <aqua>play.craftingforchrist.net</aqua> to play.</green>"));
                            } else {
                                player.sendMessage(MM.deserialize(
                                        "<red>Your Minecraft account is not in our system yet.</red>\n" +
                                        "<gray>Join <aqua>play.craftingforchrist.net</aqua> at least once first, then try again.</gray>"));
                            }
                        } catch (Exception e) {
                            player.sendMessage(MM.deserialize(
                                    "<red>Could not reach the verification server. Please try again in a moment.</red>"));
                            ZanderVelocityMain.getLogger().error("Error requesting verification code for {}", player.getUsername(), e);
                        }
                    }).schedule();
            return;
        }

        // /verify <code> — submit the code in-game
        String code = args[0];

        if (!code.matches("[0-9]{6}")) {
            player.sendMessage(MM.deserialize(
                    "<red>Please enter your 6-digit code. Example: <white>/verify 483920</white></red>"));
            return;
        }

        ZanderVelocityMain.getProxy().getScheduler()
                .buildTask(ZanderVelocityMain.getInstance(), () -> {
                    try {
                        UserVerifyCode body = UserVerifyCode.builder()
                                .uuid(player.getUniqueId())
                                .code(code)
                                .build();

                        Request req = Request.builder()
                                .setURL(baseApiUrl + "/user/verify/ingame")
                                .setMethod(Request.Method.POST)
                                .addHeader("x-access-token", apiKey)
                                .setRequestBody(body.toString())
                                .build();

                        String json = req.execute().getBody();
                        boolean success = JsonPath.read(json, "$.success");

                        if (success) {
                            player.sendMessage(MM.deserialize(
                                    "<green><bold>✔ Verified!</bold></green>\n" +
                                    "<white>Your Minecraft account is now linked to the website.</white>\n" +
                                    "<gray>You can now join <aqua>play.craftingforchrist.net</aqua> to play.</gray>"));
                        } else {
                            player.sendMessage(MM.deserialize(
                                    "<red>✘ Invalid or expired code.</red>\n" +
                                    "<gray>Codes expire after 5 minutes. Run <white>/verify</white> to get a new one.</gray>"));
                        }
                    } catch (Exception e) {
                        player.sendMessage(MM.deserialize(
                                "<red>Could not reach the verification server. Please try again.</red>"));
                        ZanderVelocityMain.getLogger().error("Error verifying account for {}", player.getUsername(), e);
                    }
                }).schedule();
    }

    private String extractCode(String message) {
        if (message == null) return null;
        Matcher m = CODE_PATTERN.matcher(message);
        return m.find() ? m.group(1) : null;
    }

    private Component buildCodeMessage(String code) {
        if (code == null) {
            return MM.deserialize("<red>Could not retrieve your verification code. Please try again.</red>");
        }
        return MM.deserialize(
                "<gold><bold>[Verification]</bold></gold>\n" +
                "<white>Your verification code is:</white>\n" +
                "<yellow><bold>" + code + "</bold></yellow>\n" +
                "<gray>──────────────────────────────</gray>\n" +
                "<white>Enter this code at:</white>\n" +
                "<aqua><underlined>craftingforchrist.net/register/minecraft</underlined></aqua>\n" +
                "<gray>This code expires in <white>5 minutes</white>.</gray>\n" +
                "<gray>──────────────────────────────</gray>\n" +
                "<gray>Or type <green>/verify <yellow>" + code + "</yellow></green> to verify in-game.</gray>"
        );
    }
}
