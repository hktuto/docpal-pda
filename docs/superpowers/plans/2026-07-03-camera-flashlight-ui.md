# Camera Flashlight Toggle + UI Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a flashlight toggle that defaults to on and remembers its state for the current app session, while restyling the native Android camera controls to a standard camera-app layout.

**Architecture:** Capture the CameraX `Camera` instance in `RectangleCameraActivity` and control the torch through `camera.getCameraControl().enableTorch(boolean)`. Store the toggle state in a static field so it survives activity recreation but resets when the app process restarts. Replace the plain text buttons with circular icon buttons defined in XML drawable and layout resources.

**Tech Stack:** Android native, CameraX, Java, XML vector/shape drawables.

---

## File structure

- **Create:** `android/app/src/main/res/drawable/ic_close.xml`
- **Create:** `android/app/src/main/res/drawable/ic_flash_on.xml`
- **Create:** `android/app/src/main/res/drawable/ic_flash_off.xml`
- **Create:** `android/app/src/main/res/drawable/shutter_button.xml`
- **Create:** `android/app/src/main/res/drawable/circle_secondary_button.xml`
- **Modify:** `android/app/src/main/res/layout/activity_rectangle_camera.xml`
- **Modify:** `android/app/src/main/java/com/docpal/warehousedemo/RectangleCameraActivity.java`

---

### Task 1: Add icon drawables

**Files:**
- Create: `android/app/src/main/res/drawable/ic_close.xml`
- Create: `android/app/src/main/res/drawable/ic_flash_on.xml`
- Create: `android/app/src/main/res/drawable/ic_flash_off.xml`

- [ ] **Step 1: Create close icon**

Create `android/app/src/main/res/drawable/ic_close.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24"
    android:tint="#FFFFFF">
    <path
        android:fillColor="#FFFFFF"
        android:pathData="M19,6.41L17.59,5 12,10.59 6.41,5 5,6.41 10.59,12 5,17.59 6.41,19 12,13.41 17.59,19 19,17.59 13.41,12z" />
</vector>
```

- [ ] **Step 2: Create flash-on icon**

Create `android/app/src/main/res/drawable/ic_flash_on.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24"
    android:tint="#FFFFFF">
    <path
        android:fillColor="#FFFFFF"
        android:pathData="M7,2v11h3v9l7,-12h-4l4,-8z" />
</vector>
```

- [ ] **Step 3: Create flash-off icon**

Create `android/app/src/main/res/drawable/ic_flash_off.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24"
    android:tint="#FFFFFF">
    <path
        android:fillColor="#FFFFFF"
        android:pathData="M3.27,3L2,4.27l5,5V13h3v9l3.58,-6.14L17.73,20 19,18.73 3.27,3zM17,10h-4l4,-8H7v2.18l8.46,8.46L17,10z" />
</vector>
```

- [ ] **Step 4: Commit drawable additions**

```bash
git add android/app/src/main/res/drawable/ic_close.xml \
        android/app/src/main/res/drawable/ic_flash_on.xml \
        android/app/src/main/res/drawable/ic_flash_off.xml
git commit -m "feat(camera): add close and flash icon drawables"
```

---

### Task 2: Add button background drawables

**Files:**
- Create: `android/app/src/main/res/drawable/circle_secondary_button.xml`
- Create: `android/app/src/main/res/drawable/shutter_button.xml`

- [ ] **Step 1: Create circular secondary button background**

Create `android/app/src/main/res/drawable/circle_secondary_button.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android"
    android:shape="oval">
    <solid android:color="#CC000000" />
    <size
        android:width="48dp"
        android:height="48dp" />
</shape>
```

- [ ] **Step 2: Create shutter button drawable**

Create `android/app/src/main/res/drawable/shutter_button.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
    <item>
        <shape android:shape="oval">
            <solid android:color="#CCFFFFFF" />
            <size
                android:width="72dp"
                android:height="72dp" />
        </shape>
    </item>
    <item
        android:left="6dp"
        android:top="6dp"
        android:right="6dp"
        android:bottom="6dp">
        <shape android:shape="oval">
            <stroke
                android:width="3dp"
                android:color="#FFFFFF" />
            <solid android:color="#FFFFFFFF" />
        </shape>
    </item>
</layer-list>
```

- [ ] **Step 3: Commit button backgrounds**

```bash
git add android/app/src/main/res/drawable/circle_secondary_button.xml \
        android/app/src/main/res/drawable/shutter_button.xml
git commit -m "feat(camera): add circular button backgrounds"
```

---

### Task 3: Restyle the camera layout

**Files:**
- Modify: `android/app/src/main/res/layout/activity_rectangle_camera.xml`

- [ ] **Step 1: Replace plain buttons with circular icon controls**

Replace the entire contents of `android/app/src/main/res/layout/activity_rectangle_camera.xml` with:

```xml
<?xml version="1.0" encoding="utf-8"?>
<FrameLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:background="#000000">

    <androidx.camera.view.PreviewView
        android:id="@+id/previewView"
        android:layout_width="match_parent"
        android:layout_height="match_parent" />

    <com.docpal.warehousedemo.RectangleOverlayView
        android:id="@+id/overlayView"
        android:layout_width="match_parent"
        android:layout_height="match_parent" />

    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:layout_gravity="bottom"
        android:layout_marginBottom="32dp"
        android:gravity="center_vertical"
        android:orientation="horizontal"
        android:paddingHorizontal="32dp">

        <ImageButton
            android:id="@+id/cancelButton"
            android:layout_width="56dp"
            android:layout_height="56dp"
            android:layout_weight="1"
            android:background="@drawable/circle_secondary_button"
            android:contentDescription="Cancel"
            android:scaleType="centerInside"
            android:src="@drawable/ic_close" />

        <View
            android:layout_width="0dp"
            android:layout_height="0dp"
            android:layout_weight="2" />

        <ImageButton
            android:id="@+id/captureButton"
            android:layout_width="80dp"
            android:layout_height="80dp"
            android:layout_weight="2"
            android:background="@drawable/shutter_button"
            android:contentDescription="Capture"
            android:scaleType="centerInside" />

        <View
            android:layout_width="0dp"
            android:layout_height="0dp"
            android:layout_weight="2" />

        <ImageButton
            android:id="@+id/flashButton"
            android:layout_width="56dp"
            android:layout_height="56dp"
            android:layout_weight="1"
            android:background="@drawable/circle_secondary_button"
            android:contentDescription="Toggle flash"
            android:scaleType="centerInside"
            android:src="@drawable/ic_flash_on" />

    </LinearLayout>

</FrameLayout>
```

- [ ] **Step 2: Commit layout restyle**

```bash
git add android/app/src/main/res/layout/activity_rectangle_camera.xml
git commit -m "feat(camera): restyle camera controls with circular icon buttons"
```

---

### Task 4: Implement flashlight toggle and wire controls

**Files:**
- Modify: `android/app/src/main/java/com/docpal/warehousedemo/RectangleCameraActivity.java`

- [ ] **Step 1: Add CameraX Camera import and static torch state**

Add the `Camera` import near the other CameraX imports:

```java
import androidx.camera.core.Camera;
```

Add fields in `RectangleCameraActivity`:

```java
private static boolean sTorchOn = true;

private Camera camera;
private ImageButton flashButton;
```

- [ ] **Step 2: Update view binding to use ImageButton and add flash button**

In `onCreate`, replace:

```java
previewView = findViewById(R.id.previewView);
overlayView = findViewById(R.id.overlayView);
cancelButton = findViewById(R.id.cancelButton);
captureButton = findViewById(R.id.captureButton);
```

with:

```java
previewView = findViewById(R.id.previewView);
overlayView = findViewById(R.id.overlayView);
cancelButton = findViewById(R.id.cancelButton);
captureButton = findViewById(R.id.captureButton);
flashButton = findViewById(R.id.flashButton);
```

Also change the field declarations for `cancelButton` and `captureButton` from `Button` to `ImageButton`:

```java
private ImageButton cancelButton;
private ImageButton captureButton;
private ImageButton flashButton;
```

- [ ] **Step 3: Add flash toggle click listener**

After the existing click listeners in `onCreate`, add:

```java
flashButton.setOnClickListener(v -> toggleTorch());
```

- [ ] **Step 4: Add toggleTorch and updateFlashIcon methods**

Add these methods to `RectangleCameraActivity`:

```java
private void toggleTorch() {
  if (camera == null) {
    return;
  }
  sTorchOn = !sTorchOn;
  camera.getCameraControl().enableTorch(sTorchOn);
  updateFlashIcon();
}

private void updateFlashIcon() {
  flashButton.setImageResource(sTorchOn ? R.drawable.ic_flash_on : R.drawable.ic_flash_off);
}
```

- [ ] **Step 5: Capture Camera instance and apply torch state on bind**

In `bindCamera`, change:

```java
cameraProvider.bindToLifecycle(
  this,
  cameraSelector,
  preview,
  imageAnalysis,
  imageCapture
);
```

to:

```java
camera = cameraProvider.bindToLifecycle(
  this,
  cameraSelector,
  preview,
  imageAnalysis,
  imageCapture
);

if (camera != null && camera.getCameraInfo().hasFlashUnit()) {
  camera.getCameraControl().enableTorch(sTorchOn);
  updateFlashIcon();
  flashButton.setVisibility(android.view.View.VISIBLE);
} else {
  flashButton.setVisibility(android.view.View.GONE);
}
```

- [ ] **Step 6: Build and verify compilation**

Run:

```bash
cd android
export JAVA_HOME='/c/Program Files/Android/Android Studio/jbr'
export PATH="$JAVA_HOME/bin:$PATH"
./gradlew :app:compileDebugJavaWithJavac
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 7: Commit flashlight toggle implementation**

```bash
git add android/app/src/main/java/com/docpal/warehousedemo/RectangleCameraActivity.java
git commit -m "feat(camera): add flashlight toggle with session state"
```

---

### Task 5: Install and test on Android

**Files:**
- None (verification step)

- [ ] **Step 1: Sync web assets and install debug APK**

Run from the project root:

```bash
pnpm generate
npx cap sync android
cd android
export JAVA_HOME='/c/Program Files/Android/Android Studio/jbr'
export PATH="$JAVA_HOME/bin:$PATH"
./gradlew :app:installDebug
```

Expected: `BUILD SUCCESSFUL` and `Installed on 1 device.`.

- [ ] **Step 2: Manual UI/flash verification**

On the Android device:

1. Open the app and navigate to a camera scan flow.
2. Verify the flashlight turns on automatically when the camera opens.
3. Tap the flash button — the icon should switch to flash-off and the flashlight should turn off.
4. Close the camera and reopen it in the same app session — flashlight should still be off.
5. Kill the app from recents and reopen it — flashlight should default back to on.
6. Confirm the shutter button still captures and the close button still cancels.

- [ ] **Step 3: Commit any final fixes**

If changes were needed during testing, commit them with a descriptive message.

---

## Self-review checklist

**Spec coverage:**
- Flashlight toggle button added — Task 3 layout + Task 4 behavior.
- Default on — `private static boolean sTorchOn = true;` in Task 4.
- Remember during current session — static field in Task 4.
- Camera-app style UI — Task 2 + Task 3.
- Hide flash if no flash unit — `hasFlashUnit()` check in Task 4 Step 5.
- Existing capture behavior preserved — shutter and cancel listeners remain unchanged.

**Placeholder scan:** No TBDs, TODOs, or vague steps. Each step includes exact file paths and code/commands.

**Type consistency:** Field names (`sTorchOn`, `camera`, `flashButton`) and drawable names (`ic_flash_on`, `ic_flash_off`) are consistent across tasks.
