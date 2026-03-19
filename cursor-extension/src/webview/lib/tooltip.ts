import { writable } from "svelte/store";

export const tooltipState = writable<{
  text: string;
  visible: boolean;
  x: number;
  y: number;
}>({ text: "", visible: false, x: 0, y: 0 });

/**
 * Svelte action: attach to any element to show a tooltip on hover.
 * Usage: <span use:tooltip={"Some description"}>...</span>
 */
export function tooltip(node: HTMLElement, text: string) {
  let currentText = text;

  function onEnter(e: MouseEvent) {
    if (!currentText) return;
    tooltipState.set({
      text: currentText,
      visible: true,
      x: e.clientX + 12,
      y: e.clientY + 12,
    });
  }

  function onMove(e: MouseEvent) {
    tooltipState.update((s) => ({ ...s, x: e.clientX + 12, y: e.clientY + 12 }));
  }

  function onLeave() {
    tooltipState.set({ text: "", visible: false, x: 0, y: 0 });
  }

  node.addEventListener("mouseenter", onEnter);
  node.addEventListener("mousemove", onMove);
  node.addEventListener("mouseleave", onLeave);

  return {
    update(newText: string) {
      currentText = newText;
    },
    destroy() {
      node.removeEventListener("mouseenter", onEnter);
      node.removeEventListener("mousemove", onMove);
      node.removeEventListener("mouseleave", onLeave);
      onLeave();
    },
  };
}
