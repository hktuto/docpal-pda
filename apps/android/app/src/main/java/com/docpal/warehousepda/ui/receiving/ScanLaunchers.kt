package com.docpal.warehousepda.ui.receiving

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import com.docpal.warehousepda.scanner.RectangleCameraActivity
import org.json.JSONArray

/** Parsed result of a camera label scan (see RectangleOcrHelper extras). */
data class CameraScanResult(
    val rawText: String,
    val barcodes: List<OcrBarcodeValue>,
    val imagePath: String?,
)

data class OcrBarcodeValue(val value: String, val format: String)

internal fun parseScanResult(data: Intent?): CameraScanResult? {
    if (data == null) return null
    val text = data.getStringExtra("text") ?: ""
    val imagePath = data.getStringExtra("imagePath")
    val barcodesJson = data.getStringExtra("barcodes") ?: "[]"
    val barcodes = ArrayList<OcrBarcodeValue>()
    try {
        val array = JSONArray(barcodesJson)
        for (i in 0 until array.length()) {
            val obj = array.getJSONObject(i)
            barcodes.add(OcrBarcodeValue(obj.optString("value"), obj.optString("format")))
        }
    } catch (e: org.json.JSONException) {
        // Scanner always writes valid JSON; keep text/imagePath if it ever doesn't.
    }
    return CameraScanResult(rawText = text, barcodes = barcodes, imagePath = imagePath)
}

/**
 * Camera-scan entry point: requests CAMERA at runtime if needed, then launches
 * RectangleCameraActivity in label-scan mode. Cancelled/failed scans are ignored.
 * Returns a `launch` function — call it from the scan FAB.
 */
@Composable
fun rememberCameraScanLauncher(onResult: (CameraScanResult) -> Unit): () -> Unit {
    val context = LocalContext.current

    val scanLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            parseScanResult(result.data)?.let(onResult)
        }
    }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) {
            scanLauncher.launch(
                Intent(context, RectangleCameraActivity::class.java)
                    .putExtra(RectangleCameraActivity.EXTRA_MODE, RectangleCameraActivity.MODE_LABEL_SCAN)
            )
        }
    }

    return remember {
        {
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA)
                == PackageManager.PERMISSION_GRANTED
            ) {
                scanLauncher.launch(
                    Intent(context, RectangleCameraActivity::class.java)
                        .putExtra(RectangleCameraActivity.EXTRA_MODE, RectangleCameraActivity.MODE_LABEL_SCAN)
                )
            } else {
                permissionLauncher.launch(Manifest.permission.CAMERA)
            }
        }
    }
}
