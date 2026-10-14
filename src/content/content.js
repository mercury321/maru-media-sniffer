(() => {
  const getMeta = (name, property) => document.querySelector(`meta[name="${name}"], meta[property="${property}"]`)?.content || "";
  const extractBvid = () => isBilibili(location.href) ? location.href.match(/BV[0-9A-Za-z]{10}/)?.[0] || document.body?.innerHTML.match(/BV[0-9A-Za-z]{10}/)?.[0] || "" : "";
  const firstText = selectors => document.querySelector(selectors)?.textContent?.replace(/\s+/g, " ").trim() || "";
  const weiboContext = () => {
    if (!isWeibo(location.href)) return {};
    const postText = firstText('[class*="detail_wbtext"], [class*="Feed_body"] [class*="text"], [node-type="feed_list_content"], article [class*="text"], .weibo-text');
    const author = firstText('[class*="head_name"], [class*="username"], a[usercard], header a[href*="/u/"]');
    const title = postText || getMeta("description", "og:description") || getMeta("", "og:title");
    return { weiboTitle: title, weiboOwner: /^\d+$/.test(author) ? "" : author };
  };
  const pageContext = () => {
    const pageTitle = document.title.trim();
    const weibo = weiboContext();
    const titleNode = document.querySelector("h1.video-title, h1[class*='video-title'], [class*='video-info'] h1, [class*='video-title']");
    const videoTitle = weibo.weiboTitle || getMeta("", "og:title") || titleNode?.textContent?.trim() || document.querySelector("video")?.getAttribute("title") || pageTitle.replace(/\s*[-_|｜_].*$/, "").trim();
    const cover = getMeta("", "og:image") || document.querySelector("video")?.poster || "";
    const owner = weibo.weiboOwner || getMeta("author", "og:article:author") || document.querySelector("[class*='up-name'],[class*='author'],[rel='author']")?.textContent?.trim() || "";
    const episode = isWeibo(location.href) ? "" : document.querySelector("[class*='page-info'] [class*='title'],[class*='video-page-card']")?.textContent?.trim() || "";
    const playerCount = [...document.querySelectorAll("video")].filter(video => Math.max(0, video.clientWidth * video.clientHeight) >= 20000).length;
    return { url: location.href, pageTitle, title: cleanTitle(videoTitle, sourceHost(location.href)), videoTitle: cleanTitle(videoTitle, sourceHost(location.href)), owner: cleanTitle(owner, ""), cover, bvid: extractBvid(), episode: cleanTitle(episode, ""), host: sourceHost(location.href), isBilibili: isBilibili(location.href), isWeibo: isWeibo(location.href), playerCount };
  };
  const send = () => chrome.runtime.sendMessage({ type: "page-context", context: pageContext() });
  const sendMediaHints = entries => {
    const seen = new Set();
    const items = entries.map(entry => {
      if (typeof entry === "string") return { url: entry };
      return { ...entry, url: entry.url || entry.name || "" };
    }).map(item => ({ ...item, type: item.type || classifyMediaUrl(item.url) })).filter(item => {
      if (!item.url || seen.has(item.url) || !item.type) return false;
      seen.add(item.url); return true;
    });
    if (items.length) chrome.runtime.sendMessage({ type: "media-hints", items, documentUrl: location.href });
    return items.length;
  };
  const domMediaUrls = () => [...document.querySelectorAll("video, audio")].flatMap(media => {
    const playerArea = Math.max(0, media.clientWidth * media.clientHeight);
    const details = { isPlayer: true, playerArea, duration: Number.isFinite(media.duration) ? media.duration : 0, currentTime: Number.isFinite(media.currentTime) ? media.currentTime : 0 };
    const ownUrls = [media.currentSrc, media.src, media.getAttribute("src")].filter(Boolean).map(url => ({ url, ...details }));
    const sourceUrls = [...media.querySelectorAll("source")].flatMap(source => [source.src, source.getAttribute("src")]).filter(Boolean).map(url => ({ url, ...details }));
    return [...ownUrls, ...sourceUrls];
  });
  const weiboScriptUrls = () => {
    if (!isWeibo(location.href)) return [];
    const urls = [];
    document.querySelectorAll("script:not([src])").forEach(script => {
      const matches = script.textContent?.match(/https?:\\?\/\\?\/[^"'\\\s]+?\.(?:mp4|m3u8)(?:\\?[^"'\\\s]*)?/gi) || [];
      matches.forEach(value => {
        const decoded = value.replace(/\\\//g, "/").replace(/\\u0026/gi, "&").replace(/&amp;/g, "&");
        if (/^https?:\/\//i.test(decoded)) urls.push(decoded);
      });
    });
    return urls;
  };
  const requestYouTubeFormats = () => document.dispatchEvent(new CustomEvent("maru-youtube-request"));
  const collectNow = () => { send(); requestYouTubeFormats(); return sendMediaHints([...domMediaUrls(), ...performance.getEntriesByType("resource"), ...weiboScriptUrls()]); };
  document.addEventListener("maru-youtube-formats", event => {
    try {
      const payload = JSON.parse(String(event.detail || "{}"));
      const items = (payload.formats || []).map(format => ({
        url: format.url,
        type: "dash",
        platform: "youtube",
        streamKind: format.isProgressive ? "complete" : format.hasAudio && !format.hasVideo ? "audio" : "video",
        mime: format.mimeType || "",
        byteSize: Number(format.contentLength || 0),
        bitrate: Number(format.bitrate || 0),
        width: Number(format.width || 0),
        height: Number(format.height || 0),
        qualityLabel: format.qualityLabel || "",
        itag: Number(format.itag || 0)
      }));
      sendMediaHints(items);
    } catch { /* Ignore incomplete player data during navigation. */ }
  });
  send();
  try { new PerformanceObserver(list => sendMediaHints(list.getEntries())).observe({ type: "resource", buffered: true }); } catch { /* Older pages still use explicit collection. */ }
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== "collect-now") return;
    sendResponse({ ok: true, found: collectNow() });
  });
  let last = location.href;
  new MutationObserver(() => { if (last !== location.href) { last = location.href; setTimeout(collectNow, 500); } }).observe(document.documentElement, { subtree: true, childList: true });
  window.addEventListener("popstate", () => setTimeout(collectNow, 300));
  window.addEventListener("hashchange", () => setTimeout(collectNow, 300));
  setTimeout(requestYouTubeFormats, 700);
})();
