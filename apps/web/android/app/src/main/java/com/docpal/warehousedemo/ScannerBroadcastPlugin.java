package com.docpal.warehousedemo;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Receives hardware-scanner broadcast intents and forwards them to JS as
 * "scan" events. This replaces keyboard-wedge output ("Output to keyboard"),
 * which injects one key event per character through the WebView input
 * pipeline and is noticeably slow on long labels.
 *
 * Delivery paths:
 *  - Context-registered receiver below: catches fully implicit broadcasts
 *    (no target package) while the app is running.
 *  - ScannerBroadcastReceiver (manifest component): catches explicit
 *    broadcasts targeted at package/class, even when the app is not running
 *    (dropped then — no active plugin instance).
 *
 * Device setup (Scanner app → Function settings / directional output):
 *   Barcode data output mode = "Output to broadcast"
 *   PackageName  = com.docpal.warehousedemo
 *   ClassName    = com.docpal.warehousedemo.ScannerBroadcastReceiver
 *   Scan Result Action   = ACTION_BARCODE_SCANNED (Enable Intent ON)
 *   Scan Result Data Key = "barcode" (the firmware default "bacode" typo is
 *                          also accepted)
 * Verify with: adb logcat -s ScannerBroadcast
 * (this ROM suppresses DEBUG logcat lines — logs use INFO level on purpose)
 */
@CapacitorPlugin(name = "ScannerBroadcast")
public class ScannerBroadcastPlugin extends Plugin {

    private static final String TAG = "ScannerBroadcast";
    private static final String ACTION_BARCODE_SCANNED = "com.wclsolution.docpal.action.BARCODE_SCANNED";
    private static final String EXTRA_BARCODE = "barcode";
    /** This scanner firmware's default "Scan Result Data Key" is misspelled. */
    private static final String EXTRA_BARCODE_TYPO = "bacode";

    /** Window in which an identical value counts as a double delivery of one scan. */
    private static final long DEDUP_WINDOW_MS = 400;

    private static ScannerBroadcastPlugin activeInstance;
    private static String lastValue;
    private static long lastAt;

    /**
     * Shared entry point for both receivers. Both fire for a package-only
     * broadcast, so identical values inside DEDUP_WINDOW_MS are treated as one
     * scan (two physical trigger pulls cannot realistically land that close).
     */
    public static void dispatchScan(Intent intent) {
        String value = intent.getStringExtra(EXTRA_BARCODE);
        if (value == null) value = intent.getStringExtra(EXTRA_BARCODE_TYPO);
        if (value == null || value.isEmpty()) {
            Log.i(TAG, "scan broadcast without barcode extra, extras: " + dumpExtras(intent));
            return;
        }
        long now = System.currentTimeMillis();
        if (value.equals(lastValue) && now - lastAt < DEDUP_WINDOW_MS) {
            Log.i(TAG, "duplicate delivery suppressed: " + value);
            return;
        }
        lastValue = value;
        lastAt = now;
        Log.i(TAG, "scan broadcast received: " + value);
        ScannerBroadcastPlugin instance = activeInstance;
        if (instance == null) {
            Log.i(TAG, "app not ready, scan dropped: " + value);
            return;
        }
        JSObject data = new JSObject();
        data.put("value", value);
        instance.notifyListeners("scan", data);
    }

    private static String dumpExtras(Intent intent) {
        android.os.Bundle extras = intent.getExtras();
        if (extras == null) return "(none)";
        StringBuilder sb = new StringBuilder();
        for (String key : extras.keySet()) {
            if (sb.length() > 0) sb.append(", ");
            sb.append(key).append("=").append(extras.get(key));
        }
        return sb.toString();
    }

    private BroadcastReceiver receiver;

    @Override
    public void load() {
        activeInstance = this;
        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                dispatchScan(intent);
            }
        };
        IntentFilter filter = new IntentFilter(ACTION_BARCODE_SCANNED);
        Context context = getContext();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            // Exported: the broadcast is sent by the scanner service (another app).
            context.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED);
        } else {
            context.registerReceiver(receiver, filter);
        }
        Log.i(TAG, "receiver registered for " + ACTION_BARCODE_SCANNED);
    }

    @Override
    protected void handleOnDestroy() {
        if (receiver != null) {
            getContext().unregisterReceiver(receiver);
            receiver = null;
        }
        if (activeInstance == this) {
            activeInstance = null;
        }
        super.handleOnDestroy();
    }
}
