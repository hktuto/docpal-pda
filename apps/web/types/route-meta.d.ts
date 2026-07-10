declare module 'vue-router' {
  interface RouteMeta {
    /** Custom page props bag used by this app for flags like noPadding. */
    props?: {
      noPadding?: boolean;
    };
  }
}

export {};
