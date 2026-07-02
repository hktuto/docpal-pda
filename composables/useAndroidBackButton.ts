import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";

let lastBackAt = 0;
const DOUBLE_TAP_MS = 2000;

export function useAndroidBackButton() {
  if (!Capacitor.isNativePlatform()) return;

  const router = useRouter();

  App.addListener("backButton", ({ canGoBack }) => {
    if (canGoBack) {
      router.back();
      return;
    }

    // On the root route, require two taps within DOUBLE_TAP_MS to exit.
    const now = Date.now();
    if (now - lastBackAt < DOUBLE_TAP_MS) {
      App.exitApp();
    } else {
      lastBackAt = now;
      // Optional: show a toast/alert like "Press back again to exit"
    }
  });
}
