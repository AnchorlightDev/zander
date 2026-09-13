package org.modularsoft.zander.waterfall.model.discord;

import com.google.gson.Gson;
import lombok.Builder;
import lombok.Getter;

@Builder
public class DiscordChat {

    @Getter String username;
    @Getter String server;
    @Getter String content;

    @Override
    public String toString() {
        return new Gson().toJson(this);
    }

}
