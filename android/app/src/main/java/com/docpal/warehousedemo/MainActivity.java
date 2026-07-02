package com.docpal.warehousedemo;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ObjectDetectionPlugin.class);
        registerPlugin(RectangleDetectionPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
