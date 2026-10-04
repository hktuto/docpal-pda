package com.docpal.warehousedemo;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Manifest-declared target for the scanner's "directional output" config
 * (PackageName + ClassName). Explicit component broadcasts only reach
 * manifest components — the plugin's context-registered receiver would be
 * invisible to them. Delivery is shared via ScannerBroadcastPlugin.dispatchScan.
 */
public class ScannerBroadcastReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        ScannerBroadcastPlugin.dispatchScan(intent);
    }
}
