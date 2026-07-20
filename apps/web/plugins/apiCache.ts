import { setApiCacheEnabled } from "~/services/apiCache";

// Applies the build-time cache kill switch (NUXT_PUBLIC_API_CACHE=off).
export default defineNuxtPlugin(() => {
  const { apiCache } = useRuntimeConfig().public;
  setApiCacheEnabled(apiCache !== "off");
});
