package dev.anchorlight.zander.velocity.events;

import com.velocitypowered.api.event.Subscribe;
import com.velocitypowered.api.event.connection.DisconnectEvent;
import com.velocitypowered.api.event.player.ServerPostConnectEvent;
import com.velocitypowered.api.proxy.Player;
import dev.anchorlight.zander.velocity.ZanderVelocityMain;
import dev.anchorlight.zander.velocity.util.nickname.NicknameCache;

import java.util.concurrent.TimeUnit;

/**
 * Keeps nickname display in sync across the network.
 *
 *  - On join/switch: refresh the player's own nickname and push it to everyone's
 *    tab list, and (shortly after, once the tab list is populated) apply known
 *    nicknames to the joiner's own tab view.
 *  - On disconnect: drop the cache entry.
 */
public class NicknameListener {

    @Subscribe
    public void onServerConnected(ServerPostConnectEvent event) {
        Player player = event.getPlayer();

        // Refresh this player's nickname and broadcast it to all tab lists.
        NicknameCache.refreshAsync(player);

        // The joiner's own tab list is populated a moment after connect; apply
        // everyone else's nicknames to it then.
        ZanderVelocityMain.getProxy().getScheduler()
                .buildTask(ZanderVelocityMain.getInstance(), () -> NicknameCache.applyAllTabsForViewer(player))
                .delay(1, TimeUnit.SECONDS)
                .schedule();
    }

    @Subscribe
    public void onDisconnect(DisconnectEvent event) {
        NicknameCache.invalidate(event.getPlayer().getUniqueId());
    }
}
