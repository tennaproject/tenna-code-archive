interface HoverPopoverOptions {
  interactive?: boolean;
  placement?: "top" | "bottom";
}

interface HoverPopoverBinding {
  show(): void;
}

let activePopover: HTMLElement | undefined;
let activeTrigger: HTMLElement | undefined;
let activeCloseTimer: number | undefined;
let nextPopoverId = 0;

function hideActivePopover(): void {
  activePopover?.removeAttribute("data-open");
  activeTrigger?.setAttribute("aria-expanded", "false");
  activePopover = undefined;
  activeTrigger = undefined;
  if (activeCloseTimer !== undefined) {
    window.clearTimeout(activeCloseTimer);
    activeCloseTimer = undefined;
  }
}

function positionPopover(
  trigger: HTMLElement,
  popover: HTMLElement,
  placement: "top" | "bottom",
): void {
  const margin = 8;
  const gap = 6;
  const triggerRect = trigger.getBoundingClientRect();
  const popoverRect = popover.getBoundingClientRect();
  const preferredTop =
    placement === "top" ? triggerRect.top - popoverRect.height - gap : triggerRect.bottom + gap;
  const alternateTop =
    placement === "top" ? triggerRect.bottom + gap : triggerRect.top - popoverRect.height - gap;
  const top =
    preferredTop >= margin && preferredTop + popoverRect.height <= window.innerHeight - margin
      ? preferredTop
      : Math.max(margin, Math.min(alternateTop, window.innerHeight - popoverRect.height - margin));
  const centeredLeft = triggerRect.left + triggerRect.width / 2 - popoverRect.width / 2;
  const left = Math.min(
    Math.max(margin, Math.min(centeredLeft, window.innerWidth - popoverRect.width - margin)),
    window.innerWidth - margin,
  );
  popover.style.top = `${top}px`;
  popover.style.left = `${left}px`;
}

function scheduleClose(trigger: HTMLElement, popover: HTMLElement): void {
  if (activeCloseTimer !== undefined) window.clearTimeout(activeCloseTimer);
  activeCloseTimer = window.setTimeout(() => {
    const focused = document.activeElement;
    if (
      trigger.matches(":hover, :focus-within") ||
      popover.matches(":hover") ||
      (focused instanceof Node && popover.contains(focused))
    )
      return;
    if (activePopover === popover) hideActivePopover();
  }, 120);
}

export function bindHoverPopover(
  trigger: HTMLElement,
  popover: HTMLElement,
  options: HoverPopoverOptions = {},
): HoverPopoverBinding {
  popover.setAttribute("data-floating-popover", "");
  if (options.interactive === true) {
    nextPopoverId += 1;
    popover.id ||= `hover-popover-${nextPopoverId}`;
    trigger.setAttribute("aria-controls", popover.id);
    trigger.setAttribute("aria-expanded", "false");
  }
  document.body.append(popover);

  const show = (): void => {
    if (activeCloseTimer !== undefined) {
      window.clearTimeout(activeCloseTimer);
      activeCloseTimer = undefined;
    }
    if (activePopover !== popover) hideActivePopover();
    popover.style.visibility = "hidden";
    popover.setAttribute("data-open", "");
    positionPopover(trigger, popover, options.placement ?? "bottom");
    popover.style.visibility = "visible";
    activePopover = popover;
    activeTrigger = options.interactive === true ? trigger : undefined;
    activeTrigger?.setAttribute("aria-expanded", "true");
  };

  const hide = (): void => scheduleClose(trigger, popover);
  trigger.addEventListener("pointerenter", show);
  trigger.addEventListener("pointerleave", hide);
  trigger.addEventListener("focusin", show);
  trigger.addEventListener("focusout", hide);

  const closeOnEscape = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || activePopover !== popover) return;
    event.preventDefault();
    if (options.interactive === true && popover.contains(document.activeElement)) trigger.focus();
    hideActivePopover();
  };
  trigger.addEventListener("keydown", closeOnEscape);

  if (options.interactive === true) {
    popover.addEventListener("pointerenter", () => {
      if (activeCloseTimer !== undefined) {
        window.clearTimeout(activeCloseTimer);
        activeCloseTimer = undefined;
      }
    });
    popover.addEventListener("pointerleave", hide);
    popover.addEventListener("focusin", show);
    popover.addEventListener("focusout", hide);
    popover.addEventListener("keydown", closeOnEscape);
  }
  return { show };
}

window.addEventListener(
  "scroll",
  (event) => {
    if (
      activePopover !== undefined &&
      event.target instanceof Node &&
      activePopover.contains(event.target)
    )
      return;
    hideActivePopover();
  },
  true,
);
window.addEventListener("resize", hideActivePopover);
