package com.docpal.warehousedemo;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(RectangleDetectionPlugin.class);
        registerPlugin(ScannerBroadcastPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
