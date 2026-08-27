(() => {
  if (window.parent === window) return;
  let lastHeight = 0;
  let scheduled = false;

  function reportHeight() {
    scheduled = false;
    const height = Math.ceil(Math.max(
      document.documentElement.scrollHeight,
      document.body?.scrollHeight || 0,
    ));
    if (height === lastHeight) return;
    lastHeight = height;
    window.parent.postMessage({ type: "expert-tracker:resize", height }, "*");
  }

  function scheduleReport() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(reportHeight);
  }

  addEventListener("load", scheduleReport);
  addEventListener("resize", scheduleReport);
  new ResizeObserver(scheduleReport).observe(document.documentElement);
  scheduleReport();
})();
