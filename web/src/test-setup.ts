// Browser APIs jsdom does not implement that Noph UI components probe at
// mount (reduced-motion + layout observers).
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

if (typeof window.ResizeObserver !== 'function') {
  window.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

if (typeof window.IntersectionObserver !== 'function') {
  window.IntersectionObserver = class IntersectionObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
    root = null;
    rootMargin = '';
    thresholds = [];
  } as unknown as typeof IntersectionObserver;
}

// Web Animations API — Noph's ripple/expressive motion calls element.animate()
// inside event handlers; jsdom does not implement WAAPI.
if (typeof Element.prototype.animate !== 'function') {
  Element.prototype.animate = function animate() {
    return {
      cancel() {},
      finish() {},
      pause() {},
      play() {},
      currentTime: 0,
      playState: 'finished',
      playbackRate: 1,
      onfinish: null,
      oncancel: null,
      finished: Promise.resolve(),
      addEventListener() {},
      removeEventListener() {},
    } as unknown as Animation;
  } as typeof Element.prototype.animate;
}

if (typeof document.getAnimations !== 'function') {
  document.getAnimations = () => [];
}