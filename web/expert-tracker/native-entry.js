const mounted = new WeakMap();

export async function mountExpertTracker(container, options = {}) {
  if (!(container instanceof Element)) throw new TypeError("mountExpertTracker 需要一个 DOM 容器");
  if (mounted.has(container)) return mounted.get(container);
  const mounting = (async () => {
    const assetBase = new URL(options.assetBase || "./", import.meta.url);
    const dataBase = new URL(options.dataBase || "data/", assetBase);
    const stylesheet = new URL("embed.scoped.css", assetBase);
    stylesheet.searchParams.set("v", options.assetVersion || "20260821.3");
    const stylesheetUrl = stylesheet.href;
    if (!document.querySelector(`link[data-expert-tracker-style="${CSS.escape(stylesheetUrl)}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = stylesheetUrl;
      link.dataset.expertTrackerStyle = stylesheetUrl;
      document.head.append(link);
    }
    const response = await fetch(new URL("native-template.html", assetBase), { cache: "no-store" });
    if (!response.ok) throw new Error(`高手跟踪模板载入失败：HTTP ${response.status}`);
    container.innerHTML = await response.text();
    const root = container.querySelector("[data-expert-tracker-root]");
    if (!root) throw new Error("高手跟踪模板缺少根节点");
    root.dataset.dataBase = dataBase.href;
    await import(`${new URL("embed.js", assetBase).href}?mount=${Date.now()}`);
    return {
      root,
      unmount() { container.replaceChildren(); mounted.delete(container); },
    };
  })();
  mounted.set(container, mounting);
  try { return await mounting; }
  catch (error) { mounted.delete(container); container.replaceChildren(); throw error; }
}
