package com.docpal.warehousedemo;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.HashSet;
import java.util.Set;

/**
 * Scanner symbology control for xcheng/Movfast PDAs (e.g. T23X): the system
 * scanner app (com.xcheng.scannere3) exposes an exported ScanTestReceiver that
 * enables/disables decoder symbologies at runtime via explicit broadcasts:
 *   action = com.xcheng.scanner.action.ENABLE_SCANTYPE_BROADCAST
 *            com.xcheng.scanner.action.DISABLE_SCANTYPE_BROADCAST
 *   extra  = "scantype" -> the scanner settings app's display name for the
 *            symbology (compared against its localized string resources, so
 *            the values below must match those resources exactly, e.g.
 *            "QR CODE" with a space).
 * The change is runtime-only and device-global: it is not saved to the scanner
 * app's preferences, so a reboot (or the settings app) restores the saved
 * config. Callers re-apply on screen enter and must call restoreAll() on leave
 * and on app start (crash recovery). On non-xcheng devices the broadcasts hit
 * no receiver and are harmless no-ops.
 */
@CapacitorPlugin(name = "ScannerConfig")
public class ScannerConfigPlugin extends Plugin {

    private static final String TAG = "ScannerConfig";
    private static final String RECEIVER_PACKAGE = "com.xcheng.scannere3";
    private static final String RECEIVER_CLASS = "com.xcheng.scannere3.ScanTestReceiver";
    private static final String ACTION_ENABLE = "com.xcheng.scanner.action.ENABLE_SCANTYPE_BROADCAST";
    private static final String ACTION_DISABLE = "com.xcheng.scanner.action.DISABLE_SCANTYPE_BROADCAST";
    private static final String EXTRA_SCANTYPE = "scantype";

    /**
     * Every symbology in the scanner app's allBarcodes list (ScanUtil), using
     * its display-name resource strings, in settings-UI order.
     */
    private static final String[] ALL_SYMBOLOGIES = {
        "AZTEC", "BC412", "Code11", "Code39", "Code49", "Code93", "Code128",
        "Codabar", "CODABLOCK F", "DOTCODE", "DATA MATRIX", "EAN-8", "EAN-13",
        "GS1 DATABAR", "GS1-128", "GS1 DATA MATRIX", "HANXIN", "HK25", "ITF25",
        "Korea POST", "MATRIX 25", "MAXICODE", "MSI", "MICROPDF", "NEC25",
        "PDF417", "USPS4ST", "QR CODE", "INDUSTRIAL 25", "TELEPEN", "UPC-A",
        "UPC-E", "IATA25", "Grid Matrix"
    };

    /** Enable exactly the given symbologies; disable every other known one. */
    @PluginMethod
    public void setSymbologies(PluginCall call) {
        JSArray enabledArray = call.getArray("enabled");
        Set<String> enabled = new HashSet<>();
        if (enabledArray != null) {
            for (int i = 0; i < enabledArray.length(); i++) {
                String name = enabledArray.optString(i, null);
                if (name != null && !name.isEmpty()) enabled.add(name);
            }
        }
        int enables = 0;
        int disables = 0;
        for (String name : ALL_SYMBOLOGIES) {
            if (enabled.contains(name)) {
                send(ACTION_ENABLE, name);
                enables++;
            } else {
                send(ACTION_DISABLE, name);
                disables++;
            }
        }
        Log.i(TAG, "setSymbologies: enabled=" + enables + " disabled=" + disables);
        call.resolve();
    }

    /** Re-enable every known symbology (device-wide neutral state). */
    @PluginMethod
    public void restoreAll(PluginCall call) {
        for (String name : ALL_SYMBOLOGIES) {
            send(ACTION_ENABLE, name);
        }
        Log.i(TAG, "restoreAll: re-enabled " + ALL_SYMBOLOGIES.length + " symbologies");
        call.resolve();
    }

    /** Symbology name list for the JS side (admin UI checkbox grid). */
    @PluginMethod
    public void listSymbologies(PluginCall call) {
        JSArray names = new JSArray();
        for (String name : ALL_SYMBOLOGIES) names.put(name);
        JSObject result = new JSObject();
        result.put("names", names);
        call.resolve(result);
    }

    private void send(String action, String scantype) {
        Context context = getContext();
        if (context == null) return;
        Intent intent = new Intent(action);
        intent.setComponent(new ComponentName(RECEIVER_PACKAGE, RECEIVER_CLASS));
        intent.putExtra(EXTRA_SCANTYPE, scantype);
        context.sendBroadcast(intent);
    }
}
