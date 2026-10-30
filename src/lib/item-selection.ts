import type { ObjectDirective } from 'vue';

export interface ItemSelectionBinding {
  active: boolean;
  disabled?: boolean;
  enter: () => void;
  toggle: () => void;
}

const entries = new WeakMap<HTMLElement, { update(value: ItemSelectionBinding): void; dispose(): void }>();
const interactive = 'button, a, input, textarea, select, m3e-button, m3e-icon-button, m3e-checkbox, m3e-select, [contenteditable="true"], [data-selection-ignore]';

/** Capture the release click before the row's detail button, including shadow DOM. */
export function attachItemSelection(element: HTMLElement, initial: ItemSelectionBinding) {
  let binding = initial;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let origin: { x: number; y: number; id: number } | undefined;
  let pressed = false;
  let suppressUntil = 0;
  const cancel = () => { if (timer) clearTimeout(timer); timer = undefined; origin = undefined; };
  const nestedAction = (event: Event) => event.composedPath().some(node => {
    if (!(node instanceof HTMLElement) || node === element || !node.matches(interactive)) return false;
    const root = node.getRootNode();
    return !(root instanceof ShadowRoot && root.host.localName === 'm3e-list-action');
  });
  const down = (event: PointerEvent) => {
    cancel(); pressed = false;
    if (binding.disabled || binding.active || event.button !== 0 || !event.isPrimary || nestedAction(event)) return;
    origin = { x: event.clientX, y: event.clientY, id: event.pointerId };
    timer = setTimeout(() => {
      timer = undefined;
      if (binding.disabled || !origin || !element.isConnected) return;
      pressed = true; suppressUntil = Date.now() + 1500;
      binding.enter();
      window.getSelection()?.removeAllRanges();
    }, 550);
  };
  const move = (event: PointerEvent) => {
    if (origin && event.pointerId === origin.id && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 8) cancel();
  };
  const up = () => { if (pressed) suppressUntil = Date.now() + 800; cancel(); };
  const click = (event: MouseEvent) => {
    if (pressed || Date.now() < suppressUntil || binding.active) {
      event.preventDefault(); event.stopImmediatePropagation();
      const release = pressed || Date.now() < suppressUntil;
      pressed = false; suppressUntil = 0;
      if (!binding.disabled && binding.active && !release) binding.toggle();
    }
  };
  const context = (event: MouseEvent) => {
    cancel();
    if (binding.disabled || nestedAction(event)) return;
    event.preventDefault(); event.stopPropagation();
    binding.enter();
  };
  element.addEventListener('pointerdown', down);
  element.addEventListener('click', click, true);
  element.addEventListener('contextmenu', context);
  window.addEventListener('pointermove', move, { passive: true });
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('blur', cancel);
  window.addEventListener('scroll', cancel, true);
  element.addEventListener('dragstart', cancel);
  return {
    update(value: ItemSelectionBinding) { binding = value; if (value.disabled || value.active) cancel(); },
    dispose() {
      cancel();
      element.removeEventListener('pointerdown', down);
      element.removeEventListener('click', click, true);
      element.removeEventListener('contextmenu', context);
      element.removeEventListener('dragstart', cancel);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('scroll', cancel, true);
    }
  };
}

export const vItemSelection: ObjectDirective<HTMLElement, ItemSelectionBinding> = {
  mounted(element, binding) { entries.set(element, attachItemSelection(element, binding.value)); },
  updated(element, binding) { entries.get(element)?.update(binding.value); },
  beforeUnmount(element) { entries.get(element)?.dispose(); entries.delete(element); }
};
