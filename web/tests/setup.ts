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

// Popover API — Noph UI's Menu/Select open their menus via showPopover()/
// hidePopover() and probe matches(':popover-open'); jsdom implements none of
// it. Open state lives in a WeakSet; `toggle` events carry newState/oldState
// like the real ToggleEvent (Select's Menu listens for them).
if (typeof HTMLElement.prototype.showPopover !== 'function') {
  const openPopovers = new WeakSet<Element>();
  const fireToggle = (el: Element, newState: 'open' | 'closed', oldState: 'open' | 'closed') => {
    const event = Object.assign(new Event('toggle'), { newState, oldState });
    el.dispatchEvent(event);
  };
  HTMLElement.prototype.showPopover = function showPopover(this: HTMLElement): void {
    if (openPopovers.has(this)) return;
    openPopovers.add(this);
    fireToggle(this, 'open', 'closed');
  };
  HTMLElement.prototype.hidePopover = function hidePopover(this: HTMLElement): void {
    if (!openPopovers.has(this)) return;
    openPopovers.delete(this);
    fireToggle(this, 'closed', 'open');
  };
  HTMLElement.prototype.togglePopover = function togglePopover(
    this: HTMLElement,
    force?: boolean
  ): boolean {
    const open = openPopovers.has(this);
    const next = force ?? !open;
    if (next && !open) this.showPopover();
    else if (!next && open) this.hidePopover();
    return next;
  };
  const originalMatches = Element.prototype.matches;
  Element.prototype.matches = function matches(this: Element, selector: string): boolean {
    if (selector === ':popover-open') return openPopovers.has(this);
    return originalMatches.call(this, selector);
  };
}

// jsdom has no layout: scrollIntoView is a no-op stub (Noph menus scroll the
// selected option into view on open).
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

// CSS.supports — Noph's menu exit animation probes 'overlay: auto'; jsdom has
// no CSS global at all. Feature queries always answer "unsupported" here.
if (typeof window.CSS?.supports !== 'function') {
  const css = (window.CSS ?? {}) as typeof window.CSS;
  css.supports = () => false;
  window.CSS = css;
}