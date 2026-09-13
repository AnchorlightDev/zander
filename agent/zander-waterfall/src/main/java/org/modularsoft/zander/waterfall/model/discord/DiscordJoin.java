package org.modularsoft.zander.waterfall.model.discord;

import com.google.gson.Gson;
import lombok.Builder;
import lombok.Getter;

@Builder
public class DiscordJoin {

    @Getter String username;

    @Override
    public String toString() {
        return new Gson().toJson(this);
    }

}
