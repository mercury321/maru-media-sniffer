(() => {
  const VERSION = 2;
  if (globalThis.__maruDeepSearchVersion === VERSION) return;
  globalThis.__maruDeepSearchVersion = VERSION;

  const mediaExtension = /\.(?:mp4|webm|mov|m4v|mp3|m4a|aac|wav|m3u8)(?:$|[?#])/i;
  const urlPattern = /https?:\\?\/\\?\/[^\s"'<>\\]+/gi;
  const emitted = new Set();
  const currentStatusId = (() => {
    try {
      const pageUrl = new URL(location.href);
      return pageUrl.pathname.match(/\/status\/(\d+)/i)?.[1] || pageUrl.searchParams.get("id") || "";
    } catch { return ""; }
  })();
  const normalize = value => {
    try {
      const decoded = String(value || "").replace(/\\\//g, "/").replace(/\\u0026/gi, "&").replace(/&amp;/gi, "&");
      const url = new URL(decoded, location.href);
      url.hash = "";
      return url.href;
    } catch { return ""; }
  };
  const emit = (url, type = "") => {
    const resolved = normalize(url);
    if (!resolved || !mediaExtension.test(resolved) || emitted.has(resolved)) return;
    emitted.add(resolved);
    if (emitted.size > 500) emitted.clear();
    document.dispatchEvent(new CustomEvent("maru-deep-media", { detail: JSON.stringify({ items: [{ url: resolved, ...(type ? { type } : {}) }] }) }));
  };
  const scanString = value => {
    const text = String(value || "");
    for (const match of text.match(urlPattern) || []) emit(match);
  };
  const scanValue = (value, depth = 0, seen = new WeakSet(), budget = { remaining: 5000 }) => {
    if (depth > 8 || value == null || budget.remaining-- <= 0) return;
    if (typeof value === "string") { scanString(value); return; }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    let count = 0;
    for (const item of Array.isArray(value) ? value : Object.values(value)) {
      if (++count > 300) break;
      scanValue(item, depth + 1, seen, budget);
    }
  };
  const findStatusObjects = (value, results = [], depth = 0, seen = new WeakSet(), budget = { remaining: 5000 }) => {
    if (!currentStatusId || depth > 10 || value == null || typeof value !== "object" || seen.has(value) || budget.remaining-- <= 0) return results;
    seen.add(value);
    if (String(value.rest_id || value.id_str || "") === currentStatusId) results.push(value);
    let count = 0;
    for (const item of Array.isArray(value) ? value : Object.values(value)) {
      if (++count > 300 || results.length >= 8) break;
      findStatusObjects(item, results, depth + 1, seen, budget);
    }
    return results;
  };
  const scanJsonValue = value => {
    const targets = findStatusObjects(value);
    if (targets.length) targets.forEach(target => scanValue(target));
    else scanValue(value);
  };
  const inspectText = (text, responseUrl, mime = "") => {
    const normalizedMime = String(mime || "").toLowerCase();
    if (/mpegurl|m3u8/.test(normalizedMime) || /^\s*#EXTM3U/i.test(text)) emit(responseUrl, "hls");
    if (/json/.test(normalizedMime) || /^[\s\r\n]*[\[{]/.test(text)) {
      try { scanJsonValue(JSON.parse(text)); return; } catch { /* Scan as text below. */ }
    }
    scanString(text);
  };
  const shouldInspect = (url, mime = "") => /json|xml|mpegurl/i.test(mime) || /\.(?:json|m3u8)(?:$|[?#])/i.test(String(url || ""));

  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === "function") {
    globalThis.fetch = async function (...args) {
      const response = await originalFetch.apply(this, args);
      try {
        const url = response.url || (typeof args[0] === "string" ? args[0] : args[0]?.url || "");
        const mime = response.headers.get("content-type") || "";
        if (shouldInspect(url, mime)) response.clone().text().then(text => inspectText(text, url, mime)).catch(() => {});
      } catch { /* Keep the page's fetch behavior unchanged. */ }
      return response;
    };
    globalThis.fetch.toString = () => originalFetch.toString();
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (...args) {
    this.addEventListener("load", function () {
      try {
        const mime = this.getResponseHeader("content-type") || "";
        if (this.responseType === "json") scanJsonValue(this.response);
        else if ((!this.responseType || this.responseType === "text") && shouldInspect(this.responseURL, mime)) inspectText(this.responseText || "", this.responseURL, mime);
      } catch { /* Keep the page's XHR behavior unchanged. */ }
    }, { once: true });
    return originalOpen.apply(this, args);
  };
  XMLHttpRequest.prototype.open.toString = () => originalOpen.toString();

  const originalJsonParse = JSON.parse;
  JSON.parse = function (...args) {
    const result = originalJsonParse.apply(this, args);
    queueMicrotask(() => { try { scanJsonValue(result); } catch { /* Ignore cyclic or exotic objects. */ } });
    return result;
  };
  JSON.parse.toString = () => originalJsonParse.toString();
})();
