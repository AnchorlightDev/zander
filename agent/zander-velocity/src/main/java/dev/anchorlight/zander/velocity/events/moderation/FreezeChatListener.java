package dev.anchorlight.zander.velocity.events.moderation;

import com.velocitypowered.api.event.Subscribe;
import com.velocitypowered.api.event.player.PlayerChatEvent;
import com.velocitypowered.api.proxy.Player;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import dev.anchorlight.zander.velocity.util.ChatFreezeManager;

public class FreezeChatListener {
    @Subscribe
    public void onPlayerChat(PlayerChatEvent event) {
        Player player = event.getPlayer();

        // Allow staff to chat even if frozen
        if (ChatFreezeManager.isChatFrozen() && !player.hasPermission("zander.moderation.chat.freeze")) {
            player.sendMessage(Component.text("Chat is currently frozen by staff.")
                    .color(NamedTextColor.RED));
            // setResult is deprecated because, on 1.19.1+, a denied result
            // KICKS the player rather than dropping the message — unless
            // SignedVelocity is installed, which this plugin declares as a
            // dependency precisely to handle signed chat correctly. Left as-is
            // deliberately; changing it would alter moderation behaviour.
            event.setResult(PlayerChatEvent.ChatResult.denied());
        }
    }
}
