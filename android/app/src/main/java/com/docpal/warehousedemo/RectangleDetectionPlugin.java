package com.docpal.warehousedemo;

import android.app.Activity;
import android.content.Intent;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "RectangleDetection")
public class RectangleDetectionPlugin extends Plugin {

  @PluginMethod
  public void scanLabel(PluginCall call) {
    Intent intent = new Intent(getActivity(), RectangleCameraActivity.class);
    intent.putExtra(RectangleCameraActivity.EXTRA_MODE, RectangleCameraActivity.MODE_LABEL_SCAN);
    startActivityForResult(call, intent, "scanLabelResult");
  }

  @ActivityCallback
  private void scanLabelResult(PluginCall call, ActivityResult result) {
    if (call == null) {
      return;
    }
    if (result.getResultCode() == Activity.RESULT_OK && result.getData() != null) {
      Intent data = result.getData();
      JSObject capture = new JSObject();
      capture.put("imagePath", data.getStringExtra("imagePath"));
      String text = data.getStringExtra("text");
      capture.put("text", text != null ? text : "");
      call.resolve(capture);
    } else {
      call.reject("Cancelled");
    }
  }
}
