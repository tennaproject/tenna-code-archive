import { bindHoverPopover } from "./hover-popover";

export function bindOptionHints(root: ParentNode = document): void {
  for (const control of root.querySelectorAll<HTMLElement>("[aria-describedby]")) {
    const id = control.getAttribute("aria-describedby");
    if (id === null) continue;
    const hint = document.getElementById(id);
    if (hint === null || !hint.classList.contains("option-hint")) continue;
    bindHoverPopover(control.closest("label") ?? control, hint);
  }
}
