package org.modularsoft.zander.waterfall.model.discord.spy;

import com.google.gson.Gson;
import lombok.Builder;
import lombok.Getter;

@Builder
public class DiscordSocialSpy {

    @Getter String usernameFrom;
    @Getter String usernameTo;
    @Getter String directMessage;
    @Getter String server;

    @Override
    public String toString() {
        return new Gson().toJson(this);
    }

}
