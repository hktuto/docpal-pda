package com.docpal.warehousedemo;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.os.RemoteException;
import android.util.Log;

import com.honeywell.IExecutor;
import com.honeywell.Message;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Singleton client for the Honeywell DataCollectionService (DCS, package
 * com.intermec.datacollectionservice). Speaks JSON-RPC 2.0 inside the
 * com.honeywell.Message Parcelable over the com.honeywell.IExecutor AIDL:
 *
 *   bind(DecodeService) → root executor
 *     scanner.connect {"scanner":"dcs.scanner.imager"} → extras["session"] binder
 *       scanner.addListener (extras {"listener": eventStub}) → barcode events
 *       scanner.claim
 *       scanner.setProperties {"values": {DEC_*: bool, DPR_LAUNCH_BROWSER: false}}
 *       scanner.release / scanner.disconnect
 *
 * All blocking binder calls run on a private HandlerThread — never on the main
 * thread. Barcode events are re-posted to the main thread for the callback.
 */
public final class HoneywellScannerClient {

    private static final String TAG = "HoneywellScanner";
    private static final String DCS_PACKAGE = "com.intermec.datacollectionservice";
    private static final String DCS_CLASS = DCS_PACKAGE + ".DataCollectionService";
    private static final String DCS_ACTION = "com.honeywell.decode.DecodeService";
    private static final String SCANNER_NAME = "dcs.scanner.imager";
    private static final long CLAIM_WAIT_MS = 3000;

    /** xcheng scanner-app display name → Honeywell DEC_* property key. */
    private static final Map<String, String> XCHENG_TO_DEC = new LinkedHashMap<>();
    static {
        XCHENG_TO_DEC.put("AZTEC", "DEC_AZTEC_ENABLED");
        XCHENG_TO_DEC.put("Code11", "DEC_CODE11_ENABLED");
        XCHENG_TO_DEC.put("Code39", "DEC_CODE39_ENABLED");
        XCHENG_TO_DEC.put("Code93", "DEC_CODE93_ENABLED");
        XCHENG_TO_DEC.put("Code128", "DEC_CODE128_ENABLED");
        XCHENG_TO_DEC.put("Codabar", "DEC_CODABAR_ENABLED");
        XCHENG_TO_DEC.put("CODABLOCK F", "DEC_CODABLOCK_F_ENABLED");
        XCHENG_TO_DEC.put("DOTCODE", "DEC_DOTCODE_ENABLED");
        XCHENG_TO_DEC.put("DATA MATRIX", "DEC_DATAMATRIX_ENABLED");
        XCHENG_TO_DEC.put("EAN-8", "DEC_EAN8_ENABLED");
        XCHENG_TO_DEC.put("EAN-13", "DEC_EAN13_ENABLED");
        XCHENG_TO_DEC.put("GS1 DATABAR", "DEC_RSS_14_ENABLED");
        XCHENG_TO_DEC.put("GS1-128", "DEC_GS1_128_ENABLED");
        XCHENG_TO_DEC.put("HANXIN", "DEC_HANXIN_ENABLED");
        XCHENG_TO_DEC.put("HK25", "DEC_HK25_ENABLED");
        XCHENG_TO_DEC.put("ITF25", "DEC_I25_ENABLED");
        XCHENG_TO_DEC.put("Korea POST", "DEC_KOREA_POST_ENABLED");
        XCHENG_TO_DEC.put("MATRIX 25", "DEC_M25_ENABLED");
        XCHENG_TO_DEC.put("MAXICODE", "DEC_MAXICODE_ENABLED");
        XCHENG_TO_DEC.put("MSI", "DEC_MSI_ENABLED");
        XCHENG_TO_DEC.put("MICROPDF", "DEC_MICROPDF_ENABLED");
        XCHENG_TO_DEC.put("PDF417", "DEC_PDF417_ENABLED");
        XCHENG_TO_DEC.put("QR CODE", "DEC_QR_ENABLED");
        XCHENG_TO_DEC.put("INDUSTRIAL 25", "DEC_S25_ENABLED");
        XCHENG_TO_DEC.put("TELEPEN", "DEC_TELEPEN_ENABLED");
        XCHENG_TO_DEC.put("UPC-A", "DEC_UPCA_ENABLE");
        XCHENG_TO_DEC.put("UPC-E", "DEC_UPCE0_ENABLED");
        XCHENG_TO_DEC.put("IATA25", "DEC_IATA25_ENABLED");
        XCHENG_TO_DEC.put("Grid Matrix", "DEC_GRIDMATRIX_ENABLED");
    }

    public interface BarcodeCallback {
        void onBarcode(String data);
    }

    private static HoneywellScannerClient instance;

    public static synchronized HoneywellScannerClient getInstance() {
        if (instance == null) {
            instance = new HoneywellScannerClient();
        }
        return instance;
    }

    private final HandlerThread thread;
    private final Handler worker;
    private final Handler main;
    private final AtomicInteger rpcId = new AtomicInteger(1);

    // Guarded by `lock`.
    private final Object lock = new Object();
    private Context appContext;
    private boolean bindRequested;
    private boolean bound;
    private IExecutor rootExecutor;
    private IExecutor sessionExecutor;
    private boolean claimed;
    private CountDownLatch claimedLatch = new CountDownLatch(1);
    private Set<String> lastEnabledSymbologies; // xcheng names; null = never requested
    private BarcodeCallback barcodeCallback;

    private HoneywellScannerClient() {
        thread = new HandlerThread("honeywell-scanner");
        thread.start();
        worker = new Handler(thread.getLooper());
        main = new Handler(Looper.getMainLooper());
    }

    public void setBarcodeCallback(BarcodeCallback callback) {
        synchronized (lock) {
            barcodeCallback = callback;
        }
    }

    /** Receives scanner.* events from DCS; barcode data is forwarded to the callback. */
    private final IExecutor.Stub eventStub = new IExecutor.Stub() {
        @Override
        public Message execute(Message message) {
            if (message == null || message.action == null) return null;
            try {
                JSONObject json = new JSONObject(message.action);
                String method = json.optString("method", "");
                if ("scanner.barcodeEvent".equals(method)) {
                    JSONObject barcode = json.optJSONObject("params") != null
                            ? json.optJSONObject("params").optJSONObject("barcode") : null;
                    String data = barcode != null ? barcode.optString("data", null) : null;
                    if (data != null && !data.isEmpty()) {
                        Log.i(TAG, "barcode event: " + data + " (" + message.action + ")");
                        final String value = data;
                        main.post(() -> {
                            BarcodeCallback cb;
                            synchronized (lock) {
                                cb = barcodeCallback;
                            }
                            if (cb != null) cb.onBarcode(value);
                        });
                    }
                } else {
                    Log.i(TAG, "event: " + message.action);
                }
            } catch (JSONException e) {
                Log.w(TAG, "unparseable event payload: " + message.action, e);
            }
            return null;
        }

        @Override
        public void executeAsync(Message message, IExecutor callback) {
            // DCS delivers scanner events via this one-way transaction.
            try {
                execute(message);
            } catch (RuntimeException e) {
                Log.w(TAG, "event handling failed", e);
            }
        }
    };

    private final ServiceConnection serviceConnection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder binder) {
            Log.i(TAG, "DCS service connected: " + name);
            worker.post(() -> onBound(binder));
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            Log.w(TAG, "DCS service disconnected: " + name);
            worker.post(() -> {
                synchronized (lock) {
                    bound = false;
                    rootExecutor = null;
                    resetSessionLocked();
                }
                // System already unbound us; re-bind and re-claim proactively.
                doBind();
            });
        }
    };

    // ------------------------------------------------------------------ API

    /** Bind to DCS and claim the internal imager. Idempotent. */
    public void bind(Context context) {
        if (context != null) {
            synchronized (lock) {
                appContext = context.getApplicationContext();
            }
        }
        worker.post(this::doBind);
    }

    /** Re-claim after a pause (scanner was released to the system wedge). */
    public void claim() {
        worker.post(this::doBind);
    }

    /**
     * Apply a symbology whitelist (xcheng display names). If the session is not
     * claimed yet the request is stored and applied right after the claim.
     */
    public void setSymbologies(Set<String> enabledXchengNames) {
        synchronized (lock) {
            lastEnabledSymbologies = enabledXchengNames == null
                    ? null : new java.util.HashSet<>(enabledXchengNames);
        }
        worker.post(() -> applySymbologies(enabledXchengNames));
    }

    /** Re-enable every mapped symbology (device-wide neutral state). */
    public void restoreAll() {
        setSymbologies(new java.util.HashSet<>(XCHENG_TO_DEC.keySet()));
    }

    /** removeListener → release → disconnect → unbind. Idempotent, half-connect safe. */
    public void release() {
        worker.post(() -> {
            IExecutor session;
            synchronized (lock) {
                session = sessionExecutor;
                bindRequested = false;
            }
            if (session != null) {
                executeQuiet(session, "scanner.removeListener", null, listenerExtras(), "removeListener");
                executeQuiet(session, "scanner.release", null, null, "release");
                executeQuiet(session, "scanner.disconnect", null, null, "disconnect");
            }
            synchronized (lock) {
                resetSessionLocked();
                if (bound) {
                    try {
                        appContext.unbindService(serviceConnection);
                        Log.i(TAG, "unbound from DCS");
                    } catch (IllegalArgumentException e) {
                        Log.w(TAG, "unbindService failed: " + e.getMessage());
                    }
                    bound = false;
                    rootExecutor = null;
                }
            }
        });
    }

    // ------------------------------------------------------------- internals

    private void doBind() {
        Context context;
        synchronized (lock) {
            context = appContext;
            if (bound && claimed) {
                Log.i(TAG, "already bound and claimed, nothing to do");
                return;
            }
            bindRequested = true;
        }
        if (context == null) {
            Log.w(TAG, "bind requested before any context was provided");
            return;
        }
        synchronized (lock) {
            if (!bound) {
                Intent intent = new Intent(DCS_ACTION);
                intent.setComponent(new ComponentName(DCS_PACKAGE, DCS_CLASS));
                try {
                    boolean ok = context.bindService(intent, serviceConnection, Context.BIND_AUTO_CREATE);
                    Log.i(TAG, "bindService(" + DCS_ACTION + ") -> " + ok);
                    if (!ok) {
                        Log.w(TAG, "bindService returned false — is DCS installed?");
                    }
                } catch (SecurityException | IllegalStateException e) {
                    Log.w(TAG, "bindService failed", e);
                }
                return;
            }
        }
        // Already bound but session not (re-)established: open it now.
        openSession();
    }

    private void onBound(IBinder binder) {
        IExecutor root = IExecutor.Stub.asInterface(binder);
        synchronized (lock) {
            bound = true;
            rootExecutor = root;
        }
        openSession();
    }

    /** connect → addListener → claim, then apply any queued symbology request. */
    private void openSession() {
        IExecutor root;
        synchronized (lock) {
            root = rootExecutor;
            if (claimed && sessionExecutor != null) {
                return;
            }
            resetSessionLocked();
        }
        if (root == null) {
            Log.w(TAG, "openSession without a bound root executor");
            return;
        }

        JSONObject connectParams = new JSONObject();
        try {
            connectParams.put("scanner", SCANNER_NAME);
        } catch (JSONException e) {
            return; // constant key, never happens
        }
        Message response = executeQuiet(root, "scanner.connect", connectParams, null, "connect");
        if (response == null) {
            Log.w(TAG, "scanner.connect returned no message");
            return;
        }
        IBinder sessionBinder = response.extras != null && response.extras.get("session") instanceof IBinder
                ? (IBinder) response.extras.get("session") : null;
        if (sessionBinder == null) {
            Log.w(TAG, "scanner.connect response had no session binder: " + response.action);
            return;
        }
        IExecutor session = IExecutor.Stub.asInterface(sessionBinder);
        synchronized (lock) {
            sessionExecutor = session;
        }

        if (executeQuiet(session, "scanner.addListener", null, listenerExtras(), "addListener") == null) {
            Log.w(TAG, "scanner.addListener failed");
            return;
        }
        if (executeQuiet(session, "scanner.claim", null, null, "claim") == null) {
            Log.w(TAG, "scanner.claim failed");
            return;
        }
        synchronized (lock) {
            claimed = true;
            claimedLatch.countDown();
        }
        Log.i(TAG, "session claimed");

        Set<String> pending;
        synchronized (lock) {
            pending = lastEnabledSymbologies;
        }
        if (pending != null) {
            Log.i(TAG, "applying queued symbology request after claim");
            applySymbologies(pending);
        }
    }

    private void applySymbologies(Set<String> enabledXchengNames) {
        if (!awaitClaim()) {
            Log.w(TAG, "setSymbologies skipped: no claimed session within " + CLAIM_WAIT_MS + "ms");
            return;
        }
        IExecutor session;
        synchronized (lock) {
            session = sessionExecutor;
        }
        if (session == null) {
            Log.w(TAG, "setSymbologies skipped: session gone");
            return;
        }
        Set<String> enabled = enabledXchengNames == null
                ? java.util.Collections.<String>emptySet() : enabledXchengNames;
        try {
            JSONObject values = new JSONObject();
            for (Map.Entry<String, String> entry : XCHENG_TO_DEC.entrySet()) {
                values.put(entry.getValue(), enabled.contains(entry.getKey()));
            }
            values.put("DPR_LAUNCH_BROWSER", false);
            // Keep the hardware trigger driving the decoder while claimed.
            values.put("TRIG_CONTROL_MODE", "autoControl");
            for (String name : enabled) {
                if (!XCHENG_TO_DEC.containsKey(name)) {
                    Log.w(TAG, "setSymbologies: no Honeywell key for '" + name + "', skipped");
                }
            }
            JSONObject params = new JSONObject();
            params.put("values", values);
            Message resp = executeQuiet(session, "scanner.setProperties", params, null, "setProperties");
            Log.i(TAG, "setProperties response: " + (resp != null ? resp.action : "(null)"));
        } catch (JSONException e) {
            Log.w(TAG, "setSymbologies failed to build payload", e);
        }
    }

    private boolean awaitClaim() {
        CountDownLatch latch;
        synchronized (lock) {
            latch = claimedLatch;
        }
        try {
            return latch.await(CLAIM_WAIT_MS, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    private Map<String, Object> listenerExtras() {
        Map<String, Object> extras = new HashMap<>();
        extras.put("listener", eventStub);
        return extras;
    }

    /** Build a JSON-RPC Message and execute it; returns null (logged) on error. */
    private Message executeQuiet(IExecutor executor, String method, JSONObject params,
                                 Map<String, Object> extras, String logLabel) {
        try {
            JSONObject call = new JSONObject();
            call.put("id", rpcId.getAndIncrement());
            call.put("jsonrpc", "2.0");
            call.put("method", method);
            if (params != null) call.put("params", params);
            // DCS's root executor logs message.extras.toString() unconditionally,
            // so a null extras map crashes the call service-side.
            Message request = new Message(call.toString(),
                    extras != null ? extras : new HashMap<String, Object>());
            Message response = executor.execute(request);
            if (response == null) {
                Log.w(TAG, logLabel + ": empty response for " + call);
                return null;
            }
            String action = response.action;
            if (action == null || action.contains("\"error\"")) {
                Log.w(TAG, logLabel + " error: " + action);
                return null;
            }
            Log.i(TAG, logLabel + " ok: " + action);
            return response;
        } catch (RemoteException e) {
            Log.w(TAG, logLabel + " binder call failed — marking session dead", e);
            worker.post(this::handleDeadService);
            return null;
        } catch (JSONException e) {
            Log.w(TAG, logLabel + " failed to build payload", e);
            return null;
        } catch (RuntimeException e) {
            Log.w(TAG, logLabel + " failed", e);
            return null;
        }
    }

    private void handleDeadService() {
        synchronized (lock) {
            resetSessionLocked();
            if (bound) {
                try {
                    appContext.unbindService(serviceConnection);
                } catch (IllegalArgumentException ignored) {
                }
                bound = false;
                rootExecutor = null;
            }
        }
        doBind();
    }

    /** Caller holds `lock`. Drops session state and re-arms the claim latch. */
    private void resetSessionLocked() {
        sessionExecutor = null;
        claimed = false;
        if (claimedLatch.getCount() == 0) {
            claimedLatch = new CountDownLatch(1);
        }
    }
}
