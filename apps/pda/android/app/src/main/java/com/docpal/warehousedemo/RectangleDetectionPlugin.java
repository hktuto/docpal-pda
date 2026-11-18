package com.docpal.warehousedemo;

import android.app.Activity;
import android.content.Intent;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import org.json.JSONObject;

@CapacitorPlugin(name = "RectangleDetection")
public class RectangleDetectionPlugin extends Plugin {

  @PluginMethod
  public void scanLabel(PluginCall call) {
    boolean stream = call.getBoolean("stream", false);
    Intent intent = new Intent(getActivity(), RectangleCameraActivity.class);
    intent.putExtra(
      RectangleCameraActivity.EXTRA_MODE,
      stream ? RectangleCameraActivity.MODE_LABEL_SCAN_STREAM : RectangleCameraActivity.MODE_LABEL_SCAN
    );
    JSArray rules = call.getArray("rules");
    if (rules != null && rules.length() > 0) {
      ArrayList<String> ruleList = new ArrayList<>();
      for (int i = 0; i < rules.length(); i++) {
        JSONObject rule = rules.optJSONObject(i);
        if (rule != null) {
          ruleList.add(rule.toString());
        }
      }
      if (!ruleList.isEmpty()) {
        intent.putStringArrayListExtra(RectangleCameraActivity.EXTRA_KEYWORDS, ruleList);
      }
    }
    String analysisSize = call.getString("analysisSize", "sd");
    intent.putExtra(RectangleCameraActivity.EXTRA_ANALYSIS_SIZE, analysisSize);
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
      String barcodes = data.getStringExtra("barcodes");
      capture.put("barcodes", barcodes != null ? barcodes : "[]");
      String matchedRule = data.getStringExtra("matchedRule");
      if (matchedRule != null) {
        capture.put("matchedRule", matchedRule);
      }
      call.resolve(capture);
    } else {
      call.reject("Cancelled");
    }
  }
}
