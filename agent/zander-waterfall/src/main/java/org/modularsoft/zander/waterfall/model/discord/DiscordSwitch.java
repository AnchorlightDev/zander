package org.modularsoft.zander.waterfall.model.discord;

import com.google.gson.Gson;
import lombok.Builder;
import lombok.Getter;

@Builder
public class DiscordSwitch {

    @Getter String username;
    @Getter String server;

    @Override
    public String toString() {
        return new Gson().toJson(this);
    }

}
