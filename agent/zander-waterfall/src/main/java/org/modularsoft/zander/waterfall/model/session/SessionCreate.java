package org.modularsoft.zander.waterfall.model.session;

import com.google.gson.Gson;
import lombok.Builder;
import lombok.Getter;

import java.util.UUID;

@Builder
public class SessionCreate {

    @Getter UUID uuid;
    @Getter String ipAddress;

    @Override
    public String toString() {
        return new Gson().toJson(this);
    }

}
