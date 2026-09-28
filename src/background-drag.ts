import { useEffect } from "react";

// AppKit asks whether a mouse-down may start a drag before Chromium receives
// it. Keep native hit regions ready, instead of trying to blur an already
// raised window in a renderer mouse-down handler.
export function useBackgroundDrag(platform?: string) {
  useEffect(() => {
    if (platform !== "darwin") return;
    let frame = 0;
    let previous = "";
    const update = () => {
      frame = 0;
      const regions: { x: number; y: number; width: number; height: number }[] = [];
      if (!document.querySelector('dialog[open], [role="dialog"], [role="menu"]')) {
        for (const item of document.querySelectorAll('.file-item[draggable="true"]')) {
          const rect = item.getBoundingClientRect();
          let left = Math.max(0, rect.left);
          let top = Math.max(0, rect.top);
          let right = Math.min(innerWidth, rect.right);
          let bottom = Math.min(innerHeight, rect.bottom);
          if (right <= left || bottom <= top) continue;
          // Scrolled-out rows must not turn the toolbar/footer into drag areas.
          for (let parent = item.parentElement; parent; parent = parent.parentElement) {
            const style = getComputedStyle(parent);
            if (style.overflowX !== "visible" || style.overflowY !== "visible") {
              const clip = parent.getBoundingClientRect();
              if (style.overflowX !== "visible") {
                left = Math.max(left, clip.left);
                right = Math.min(right, clip.right);
              }
              if (style.overflowY !== "visible") {
                top = Math.max(top, clip.top);
                bottom = Math.min(bottom, clip.bottom);
              }
            }
          }
          if (right > left && bottom > top)
            regions.push({ x: left, y: top, width: right - left, height: bottom - top });
        }
      }
      const next = JSON.stringify(regions);
      if (next !== previous) {
        previous = next;
        window.sinder.setFileDragRegions(regions);
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const mutation = new MutationObserver(schedule);
    mutation.observe(document.body, {
      subtree: true, childList: true, attributes: true,
      attributeFilter: ["class", "style", "hidden", "draggable", "open"],
    });
    const resize = new ResizeObserver(schedule);
    resize.observe(document.body);
    document.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      mutation.disconnect();
      resize.disconnect();
      document.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      window.sinder.setFileDragRegions([]);
    };
  }, [platform]);
}
