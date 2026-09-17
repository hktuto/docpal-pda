// Restores the saved global text size on app start (composables/useFontSize).
export default defineNuxtPlugin(() => {
  useFontSize().initFontSize();
});
