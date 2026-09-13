package org.modularsoft.zander.waterfall.model.discord.spy;

import com.google.gson.Gson;
import lombok.Builder;
import lombok.Getter;

@Builder
public class DiscordCommandSpy {

    @Getter String username;
    @Getter String command;
    @Getter String server;

    @Override
    public String toString() {
        return new Gson().toJson(this);
    }

}
