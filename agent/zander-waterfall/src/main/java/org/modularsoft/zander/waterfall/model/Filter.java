package org.modularsoft.zander.waterfall.model;

import com.google.gson.Gson;
import lombok.Builder;
import lombok.Getter;

@Builder
public class Filter {

    @Getter String content;

    @Override
    public String toString() {
        return new Gson().toJson(this);
    }

}
