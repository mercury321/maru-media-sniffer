(() => {
  const CONTENT_PROTOCOL_VERSION = 9;
  if (globalThis.__maruMediaSnifferContentProtocol === CONTENT_PROTOCOL_VERSION) return;
  globalThis.__maruMediaSnifferContentProtocol = CONTENT_PROTOCOL_VERSION;
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
    return { url: location.href, pageTitle, title: cleanTitle(videoTitle, sourceHost(location.href)), videoTitle: cleanTitle(videoTitle, sourceHost(location.href)), owner: cleanTitle(owner, ""), cover, bvid: extractBvid(), episode: cleanTitle(episode, ""), host: sourceHost(location.href), isTopFrame: window.top === window, isBilibili: isBilibili(location.href), isWeibo: isWeibo(location.href), isYouTube: isYouTube(location.href), youtubeVideoId: youtubeVideoIdFromUrl(location.href), playerCount };
  };
  const send = (overrides = {}) => chrome.runtime.sendMessage({ type: "page-context", context: { ...pageContext(), ...overrides } });
  const absoluteUrl = value => {
    if (!value) return "";
    try { return new URL(String(value), location.href).href; } catch { return ""; }
  };
  const sendMediaHints = entries => {
    const seen = new Set();
    const items = entries.map(entry => {
      if (typeof entry === "string") return { url: entry };
      return { ...entry, url: entry.url || entry.name || "" };
    }).map(item => {
      const streamKind = item.streamKind || (isBilibili(location.href) ? bilibiliStreamKindFromUrl(item.url) : "");
      return { ...item, ...(streamKind ? { streamKind } : {}), type: item.type || classifyMediaUrl(item.url, { documentUrl: location.href, mime: item.mime || "" }) };
    }).filter(item => {
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
  const genericInlineScriptUrls = () => {
    if (isBilibili(location.href) || isWeibo(location.href) || isYouTube(location.href) || isX(location.href)) return [];
    const urls = [];
    let inspectedCharacters = 0;
    const pattern = /https?:\\?\/\\?\/[^"'\\\s<>]+?\.(?:mp4|m3u8|webm|m4a|mp3)(?:\\?[^"'\\\s<>]*)?/gi;
    for (const script of document.querySelectorAll("script:not([src])")) {
      const text = script.textContent || "";
      inspectedCharacters += text.length;
      if (inspectedCharacters > 2_000_000) break;
      for (const match of text.match(pattern) || []) {
        const decoded = match.replace(/\\\//g, "/").replace(/\\u0026/gi, "&").replace(/&amp;/gi, "&");
        if (/^https?:\/\//i.test(decoded)) urls.push(decoded);
        if (urls.length >= 100) return urls;
      }
    }
    return urls;
  };
  const weiboVideoId = () => {
    if (!isWeibo(location.href)) return "";
    try {
      const parsed = new URL(location.href);
      const pathId = decodeURIComponent(parsed.pathname).match(/\/tv\/show\/([^/?#]+)/i)?.[1] || "";
      return pathId || parsed.searchParams.get("fid") || "";
    } catch { return ""; }
  };
  const weiboStatusId = () => {
    if (!isWeibo(location.href)) return "";
    try {
      const path = decodeURIComponent(new URL(location.href).pathname);
      return path.match(/^\/\d+\/([0-9A-Za-z]+)\/?$/)?.[1]
        || path.match(/^\/(?:detail|status)\/([0-9A-Za-z]+)\/?$/i)?.[1]
        || "";
    } catch { return ""; }
  };
  const secureWeiboUrl = value => {
    const resolved = absoluteUrl(value);
    return /^http:\/\/[^/]*weibocdn\.com\//i.test(resolved) ? resolved.replace(/^http:/i, "https:") : resolved;
  };
  const weiboMediaEntries = media => {
    if (!media) return [];
    const fields = [
      ["mp4_2160p_mp4", "4K"], ["mp4_1440p_mp4", "2K"], ["mp4_1080p_mp4", "1080P"],
      ["mp4_720p_mp4", "720P"], ["hevc_mp4_720p", "720P HEVC"],
      ["stream_url_hd", "高清"], ["mp4_hd_url", "高清"], ["stream_url", "标清"], ["mp4_sd_url", "标清"]
    ];
    const entries = fields.map(([field, qualityLabel]) => ({ url: secureWeiboUrl(media[field]), type: "direct", qualityLabel, isPlayer: true }));
    for (const item of media.playback_list || []) {
      const info = item.play_info || item;
      const playbackUrl = secureWeiboUrl(info.url || info.play_url);
      if (/\.(?:mp4|m3u8)(?:$|[?#])/i.test(playbackUrl)) entries.push({ url: playbackUrl, type: "direct", qualityLabel: info.quality_desc || info.label || "播放器画质", isPlayer: true });
    }
    return entries.filter(item => item.url);
  };
  let lastWeiboResolve = { id: "", at: 0 };
  let lastWeiboStatusResolve = { id: "", at: 0 };
  const collectWeiboComponent = async () => {
    const id = weiboVideoId();
    if (!id) return 0;
    if (lastWeiboResolve.id === id && Date.now() - lastWeiboResolve.at < 5000) return 0;
    lastWeiboResolve = { id, at: Date.now() };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const response = await fetch(`/tv/api/component?page=/tv/show/${encodeURIComponent(id)}`, {
      method: "POST",
      credentials: "include",
      signal: controller.signal,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ data: JSON.stringify({ Component_Play_Playinfo: { oid: id } }) })
    }).finally(() => clearTimeout(timer));
    if (!response.ok) throw new Error(`微博播放信息请求失败：HTTP ${response.status}`);
    const payload = await response.json();
    const info = payload?.data?.Component_Play_Playinfo;
    if (!info) return 0;
    const title = info.title || info.text || "";
    const owner = info.author || info.nickname || "";
    const cover = absoluteUrl(info.cover_image || "");
    if (title || owner || cover) send({ title: cleanTitle(title, sourceHost(location.href)), videoTitle: cleanTitle(title, sourceHost(location.href)), owner: cleanTitle(owner, ""), cover });
    const entries = Object.entries(info.urls || {}).map(([qualityLabel, value]) => ({
      url: absoluteUrl(value),
      type: "direct",
      qualityLabel,
      isPlayer: true,
      playerArea: Math.max(...[...document.querySelectorAll("video")].map(video => Math.max(0, video.clientWidth * video.clientHeight)), 0)
    }));
    const streamUrl = absoluteUrl(info.stream_url || "");
    if (streamUrl) entries.push({ url: streamUrl, type: classifyMediaUrl(streamUrl, { documentUrl: location.href }) || "direct", qualityLabel: "播放器地址", isPlayer: true });
    return sendMediaHints(entries);
  };
  const collectWeiboStatus = async () => {
    const id = weiboStatusId();
    if (!id) return 0;
    if (lastWeiboStatusResolve.id === id && Date.now() - lastWeiboStatusResolve.at < 5000) return 0;
    lastWeiboStatusResolve = { id, at: Date.now() };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const response = await fetch(`/ajax/statuses/show?id=${encodeURIComponent(id)}`, {
      credentials: "include",
      signal: controller.signal,
      headers: { Accept: "application/json" }
    }).finally(() => clearTimeout(timer));
    if (!response.ok) throw new Error(`微博详情请求失败：HTTP ${response.status}`);
    const payload = await response.json();
    const media = payload?.page_info?.media_info;
    if (!media) return 0;
    const title = payload.text_raw || payload.page_info?.content1 || media.name || "";
    const owner = payload.user?.screen_name || media.author_name || "";
    const cover = secureWeiboUrl(media.big_pic_info?.pic_big?.url || media.page_pic || payload.page_info?.page_pic?.url || "");
    if (title || owner || cover) send({ title: cleanTitle(title, sourceHost(location.href)), videoTitle: cleanTitle(title, sourceHost(location.href)), owner: cleanTitle(owner, ""), cover });
    const playerArea = Math.max(...[...document.querySelectorAll("video")].map(video => Math.max(0, video.clientWidth * video.clientHeight)), 0);
    return sendMediaHints(weiboMediaEntries(media).map(item => ({ ...item, playerArea })));
  };
  const youtubeRequests = new Map();
  const requestYouTubeFormats = () => {
    if (!isYouTube(location.href)) return Promise.resolve(0);
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise(resolve => {
      const timer = setTimeout(() => { youtubeRequests.delete(requestId); resolve(0); }, 10000);
      youtubeRequests.set(requestId, count => { clearTimeout(timer); youtubeRequests.delete(requestId); resolve(count); });
      document.dispatchEvent(new CustomEvent("maru-youtube-request", { detail: JSON.stringify({ requestId }) }));
    });
  };
  const collectNow = async () => {
    send();
    const found = sendMediaHints([...domMediaUrls(), ...performance.getEntriesByType("resource"), ...weiboScriptUrls(), ...genericInlineScriptUrls()]);
    let platformFound = 0;
    try { platformFound += await requestYouTubeFormats(); } catch { /* YouTube fallback remains optional. */ }
    try { platformFound += await collectWeiboComponent(); } catch { /* Network observations can still succeed. */ }
    try { platformFound += await collectWeiboStatus(); } catch { /* DOM and network observations remain available. */ }
    return found + platformFound;
  };
  document.addEventListener("maru-deep-media", event => {
    try {
      const payload = JSON.parse(String(event.detail || "{}"));
      sendMediaHints((payload.items || []).map(item => ({ ...item, deepSearch: true })));
    } catch { /* Ignore malformed data from the page world. */ }
  });
  document.addEventListener("maru-youtube-formats", async event => {
    try {
      const payload = JSON.parse(String(event.detail || "{}"));
      const currentVideoId = youtubeVideoIdFromUrl(location.href);
      if (currentVideoId && payload.videoId && currentVideoId !== payload.videoId) {
        if (payload.requestId && youtubeRequests.has(payload.requestId)) youtubeRequests.get(payload.requestId)(0);
        return;
      }
      const youtubeTitle = payload.title ? cleanTitle(payload.title, sourceHost(location.href)) : "";
      send({
        isYouTube: true,
        youtubeVideoId: currentVideoId || payload.videoId || "",
        youtubeStatus: payload.status || "UNKNOWN",
        youtubeReason: payload.reason || "",
        youtubeEncrypted: Number(payload.encryptedCount || 0),
        youtubeSource: payload.source || "",
        ...(youtubeTitle ? { title: youtubeTitle, videoTitle: youtubeTitle } : {}),
        ...(payload.owner ? { owner: cleanTitle(payload.owner, "") } : {}),
        ...(payload.cover ? { cover: payload.cover } : {})
      });
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
      await chrome.runtime.sendMessage({
        type: "youtube-formats",
        documentUrl: location.href,
        videoId: currentVideoId || payload.videoId || "",
        status: payload.status || "UNKNOWN",
        reason: payload.reason || "",
        source: payload.source || "",
        items
      });
      if (payload.requestId && youtubeRequests.has(payload.requestId)) youtubeRequests.get(payload.requestId)(items.length);
    } catch {
      try {
        const payload = JSON.parse(String(event.detail || "{}"));
        if (payload.requestId && youtubeRequests.has(payload.requestId)) youtubeRequests.get(payload.requestId)(0);
      } catch { /* Ignore incomplete player data during navigation. */ }
    }
  });
  send();
  try { new PerformanceObserver(list => sendMediaHints(list.getEntries())).observe({ type: "resource", buffered: true }); } catch { /* Older pages still use explicit collection. */ }
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "content-version") { sendResponse({ ok: true, contentProtocol: CONTENT_PROTOCOL_VERSION }); return false; }
    if (message.type !== "collect-now") return;
    collectNow().then(found => sendResponse({ ok: true, found, contentProtocol: CONTENT_PROTOCOL_VERSION })).catch(error => sendResponse({ ok: false, found: 0, contentProtocol: CONTENT_PROTOCOL_VERSION, error: error.message || "扫描失败" }));
    return true;
  });
  let last = location.href;
  new MutationObserver(() => { if (last !== location.href) { last = location.href; setTimeout(collectNow, 500); } }).observe(document.documentElement, { subtree: true, childList: true });
  window.addEventListener("popstate", () => setTimeout(collectNow, 300));
  window.addEventListener("hashchange", () => setTimeout(collectNow, 300));
  document.addEventListener("DOMContentLoaded", () => setTimeout(collectNow, 0), { once: true });
  setTimeout(collectNow, 700);
})();
