// Import shim for `.svelte` files: svelte's own `declare module '*.svelte'`
// (node_modules/svelte/types/index.d.ts) is not pulled into this program by
// svelte-check, so imports inside .svelte scripts fall back to implicit any.
// Svelte 5 components are functions, typed as Component<...>.
declare module '*.svelte' {
  import type { Component } from 'svelte';
  const component: Component<Record<string, unknown>>;
  export default component;
}