// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachItemSelection } from './item-selection';

let cleanup: () => void;
function pointer(target: EventTarget, type: string, options: MouseEventInit = {}) {
  const event = new MouseEvent(type, { bubbles: true, composed: true, button: 0, clientX: 20, clientY: 20, ...options });
  Object.defineProperties(event, { isPrimary: { value: true }, pointerId: { value: 1 } });
  target.dispatchEvent(event);
}
function fixture() {
  const row = document.createElement('article'); row.innerHTML = '<span>Title</span><button>Edit</button>';
  document.body.append(row);
  const open = vi.fn(), enter = vi.fn(), toggle = vi.fn();
  const binding = { active: false, disabled: false, enter, toggle };
  const control = attachItemSelection(row, binding); cleanup = () => { control.dispose(); row.remove(); };
  row.addEventListener('click', open);
  return { row, open, enter, toggle, binding, control };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup?.(); vi.useRealTimers(); });

describe('item selection gestures', () => {
  it('leaves a normal click alone and consumes only the long-press release', () => {
    const f = fixture();
    pointer(f.row, 'pointerdown'); vi.advanceTimersByTime(150); pointer(window, 'pointerup'); f.row.click();
    expect(f.open).toHaveBeenCalledOnce(); expect(f.enter).not.toHaveBeenCalled();
    pointer(f.row, 'pointerdown'); vi.advanceTimersByTime(550); expect(f.enter).toHaveBeenCalledOnce();
    f.control.update({ ...f.binding, active: true });
    pointer(window, 'pointerup'); f.row.click();
    expect(f.toggle).not.toHaveBeenCalled(); expect(f.open).toHaveBeenCalledOnce();
    f.row.click(); expect(f.toggle).toHaveBeenCalledOnce();
  });

  it.each(['pointercancel', 'blur', 'scroll'])('cancels a pending press on %s', event => {
    const f = fixture(); pointer(f.row, 'pointerdown'); vi.advanceTimersByTime(300);
    window.dispatchEvent(new Event(event)); vi.advanceTimersByTime(500);
    expect(f.enter).not.toHaveBeenCalled();
  });

  it('cancels dragging beyond the movement threshold and ignores secondary buttons', () => {
    const f = fixture(); pointer(f.row, 'pointerdown'); pointer(window, 'pointermove', { clientX: 30 }); vi.advanceTimersByTime(600);
    pointer(f.row, 'pointerdown', { button: 2 }); vi.advanceTimersByTime(600);
    expect(f.enter).not.toHaveBeenCalled();
  });

  it('excludes nested actions but accepts the list-action shadow button and context menu', () => {
    const f = fixture(); pointer(f.row.querySelector('button')!, 'pointerdown'); vi.advanceTimersByTime(600);
    expect(f.enter).not.toHaveBeenCalled();
    const action = document.createElement('m3e-list-action'); const shadow = action.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button>Open</button>'; f.row.append(action);
    pointer(shadow.querySelector('button')!, 'pointerdown'); vi.advanceTimersByTime(550);
    expect(f.enter).toHaveBeenCalledOnce();
    pointer(window, 'pointerup');
    pointer(f.row, 'contextmenu', { button: 2 }); expect(f.enter).toHaveBeenCalledTimes(2);
  });

  it('blocks row actions in selection mode even while busy and clears timers on disposal', () => {
    const f = fixture(); f.control.update({ ...f.binding, active: true });
    f.row.querySelector('button')!.click(); expect(f.toggle).toHaveBeenCalledOnce(); expect(f.open).not.toHaveBeenCalled();
    f.control.update({ ...f.binding, active: true, disabled: true }); f.row.click();
    expect(f.toggle).toHaveBeenCalledOnce(); expect(f.open).not.toHaveBeenCalled();
    f.control.update(f.binding); pointer(f.row, 'pointerdown'); f.control.dispose(); vi.advanceTimersByTime(600);
    expect(f.enter).not.toHaveBeenCalled();
  });
});
