importScripts("shared.js");

const tabState = new Map();
const MAX_GROUPS = 80;
const protectedDownloads = new Set();
const downloadFailures = new Map();
const blobDownloads = new Map();
const biliResolveTimers = new Map();
const CONTENT_PROTOCOL_VERSION = 2;
let creatingOffscreen = null;

async function setMaruActionIcon() {
  const images = {};
  for (const size of [16, 32, 48]) {
    const canvas = new OffscreenCanvas(size, size);
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, size, size);
    context.beginPath(); context.arc(size / 2, size / 2, size * 0.5, 0, Math.PI * 2);
    const gradient = context.createLinearGradient(0, 0, size, size);
    gradient.addColorStop(0, "#ff5f6e"); gradient.addColorStop(1, "#d6233b");
    context.fillStyle = gradient; context.fill();
    context.fillStyle = "#ffffff";
    context.font = `700 ${Math.round(size * 0.67)}px "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif`;
    context.textAlign = "center"; context.textBaseline = "middle";
    context.fillText("丸", size / 2, size * 0.53);
    images[size] = context.getImageData(0, 0, size, size);
  }
  await chrome.action.setIcon({ imageData: images });
}

function emptyState(tabId) { return { tabId, page: { url: "", title: "", videoTitle: "", pageTitle: "", owner: "", cover: "", bvid: "", episode: "", host: "" }, groups: [], updatedAt: Date.now() }; }
function getState(tabId) { if (!tabState.has(tabId)) tabState.set(tabId, emptyState(tabId)); return tabState.get(tabId); }
async function restoreSessionState() {
  const stored = await chrome.storage.session.get(null);
  for (const [key, value] of Object.entries(stored)) {
    const match = key.match(/^tab:(\d+)$/);
    if (!match || !value || !Array.isArray(value.groups)) continue;
    const tabId = Number(match[1]);
    if (!tabState.has(tabId)) tabState.set(tabId, value);
    updateBadge(tabId, tabState.get(tabId));
  }
}
const sessionReady = restoreSessionState().catch(() => {});
function downloadableCount(state) {
  if (state.groups.some(group => group.isBilibiliComplete)) return 1;
  return state.groups.filter(group => ["direct", "hls", "dash"].includes(group.type)).length;
}
function updateBadge(tabId, state = tabState.get(tabId)) {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  const count = state ? downloadableCount(state) : 0;
  const text = count > 99 ? "99+" : count ? String(count) : "";
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#ea685b" }).catch(() => {});
  if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ tabId, color: "#ffffff" }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setTitle({ tabId, title: count ? `丸酱媒体嗅探助手 · 发现 ${count} 个媒体资源` : "丸酱媒体嗅探助手" }).catch(() => {});
}
function persist(tabId) { const state = tabState.get(tabId); if (state) { chrome.storage.session.set({ [`tab:${tabId}`]: state }); updateBadge(tabId, state); } }
function weiboQuality(url) {
  if (/(?:2160|4k)/i.test(url)) return { rank: 6, label: "4K" };
  if (/(?:1440|2k)/i.test(url)) return { rank: 5, label: "2K" };
  if (/1080/i.test(url)) return { rank: 4, label: "1080P" };
  if (/720/i.test(url)) return { rank: 3, label: "720P" };
  if (/(?:480|540)/i.test(url)) return { rank: 2, label: "480P" };
  if (/360/i.test(url)) return { rank: 1, label: "360P" };
  if (/(?:hd|high)/i.test(url)) return { rank: 2, label: "高清" };
  return { rank: 0, label: "" };
}
function weiboVariantScore(variant) {
  let score = weiboQuality(`${variant.qualityLabel || ""} ${variant.url}`).rank * 1_000_000_000;
  score += Number(variant.byteSize || 0);
  if (variant.isPlayer) score += 1000;
  if (variant.currentTime > 0) score += 1000;
  return score;
}
function mergeWeiboVariant(group, url, details, mime = "") {
  const byteSize = Number(headerValue(details.responseHeaders, "content-length") || details.byteSize || 0);
  group.variants ||= [];
  let variant = group.variants.find(item => item.url === url);
  if (!variant) { variant = { url }; group.variants.push(variant); }
  variant.byteSize = Math.max(variant.byteSize || 0, byteSize);
  variant.isPlayer = variant.isPlayer || Boolean(details.isPlayer);
  variant.currentTime = Math.max(variant.currentTime || 0, Number(details.currentTime || 0));
  variant.playerArea = Math.max(variant.playerArea || 0, Number(details.playerArea || 0));
  variant.mime = mime || variant.mime || "";
  variant.qualityLabel = details.qualityLabel || variant.qualityLabel || "";
  const best = [...group.variants].sort((a, b) => weiboVariantScore(b) - weiboVariantScore(a))[0];
  group.url = best.url;
  group.byteSize = best.byteSize || 0;
  group.size = best.byteSize ? String(best.byteSize) : "";
  group.isPlayer = Boolean(best.isPlayer);
  group.currentTime = best.currentTime || 0;
  group.playerArea = best.playerArea || 0;
  group.mime = best.mime || group.mime || "";
  group.qualityLabel = best.qualityLabel || weiboQuality(best.url).label || (best.byteSize ? "最高可用" : "播放器画质");
  group.count = group.variants.length;
  group.lastSeen = Date.now();
}
function consolidateWeiboGroups(state) {
  if (!isWeiboDetail(state.page.url)) return;
  const directGroups = state.groups.filter(group => group.type === "direct");
  if (directGroups.length < 2 && directGroups[0]?.isWeiboVideo) return;
  if (!directGroups.length) return;
  const primary = directGroups[0];
  primary.isWeiboVideo = true;
  primary.variants = [];
  for (const group of directGroups) {
    const variants = group.variants?.length ? group.variants : [{ url: group.url, byteSize: Number(group.byteSize || group.size || 0), isPlayer: group.isPlayer, currentTime: group.currentTime, playerArea: group.playerArea, mime: group.mime }];
    for (const variant of variants) mergeWeiboVariant(primary, variant.url, variant, variant.mime || "");
  }
  state.groups = [primary, ...state.groups.filter(group => group.type !== "direct")];
}
function xVideoKey(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/(?:ext_tw_video|amplify_video)\/(\d+)(?:\/|$)/i);
    return match ? `${parsed.hostname}:${match[1]}` : "";
  } catch { return ""; }
}
function isXMediaCdn(url) {
  try { return /(^|\.)video\.twimg\.com$/i.test(new URL(url).hostname); } catch { return false; }
}
function xQuality(url) {
  const match = String(url || "").match(/(?:^|\/)(\d{3,4})x(\d{3,4})(?:\/|$)/i);
  if (!match) return { rank: 0, label: "" };
  const height = Number(match[2]);
  return { rank: height, label: `${height}P` };
}
function xVariantScore(variant) {
  let score = xQuality(variant.url).rank * 1_000_000_000;
  score += Number(variant.byteSize || 0);
  if (variant.isPlayer) score += 1000;
  if (variant.currentTime > 0) score += 1000;
  return score;
}
function mergeXVariant(group, url, details, mime = "") {
  const byteSize = Number(headerValue(details.responseHeaders, "content-length") || details.byteSize || 0);
  group.hlsUrls ||= [];
  let variant = group.hlsUrls.find(item => item.url === url);
  if (!variant) { variant = { url }; group.hlsUrls.push(variant); }
  variant.byteSize = Math.max(variant.byteSize || 0, byteSize);
  variant.isPlayer = variant.isPlayer || Boolean(details.isPlayer);
  variant.currentTime = Math.max(variant.currentTime || 0, Number(details.currentTime || 0));
  variant.playerArea = Math.max(variant.playerArea || 0, Number(details.playerArea || 0));
  variant.mime = mime || variant.mime || "";
  const best = [...group.hlsUrls].sort((a, b) => xVariantScore(b) - xVariantScore(a))[0];
  group.url = best.url;
  group.byteSize = best.byteSize || 0;
  group.size = best.byteSize ? String(best.byteSize) : "";
  group.isPlayer = Boolean(best.isPlayer);
  group.currentTime = best.currentTime || 0;
  group.playerArea = best.playerArea || 0;
  group.mime = best.mime || group.mime || "";
  group.qualityLabel = xQuality(best.url).label || "最高可用";
  group.count = group.hlsUrls.length;
  group.lastSeen = Date.now();
}
function youtubeFormatScore(candidate) {
  return Number(candidate.height || 0) * 1_000_000_000 + Number(candidate.bitrate || 0) + Number(candidate.byteSize || 0);
}
function mergeYouTubeFormat(group, url, details, mime = "") {
  const kind = details.streamKind === "complete" ? "complete" : details.streamKind === "audio" ? "audio" : "video";
  group.youtubeCandidates ||= { complete: [], video: [], audio: [] };
  const list = group.youtubeCandidates[kind];
  let candidate = list.find(item => item.url === url);
  if (!candidate) { candidate = { url }; list.push(candidate); }
  candidate.mime = mime || candidate.mime || "";
  candidate.byteSize = Math.max(candidate.byteSize || 0, Number(details.byteSize || details.contentLength || 0));
  candidate.bitrate = Math.max(candidate.bitrate || 0, Number(details.bitrate || 0));
  candidate.width = Math.max(candidate.width || 0, Number(details.width || 0));
  candidate.height = Math.max(candidate.height || 0, Number(details.height || 0));
  candidate.qualityLabel = details.qualityLabel || candidate.qualityLabel || "";
  candidate.itag = Number(details.itag || candidate.itag || 0);
  list.sort((a, b) => youtubeFormatScore(b) - youtubeFormatScore(a));
  group.completeUrls = group.youtubeCandidates.complete.map(item => item.url);
  group.videoUrls = group.youtubeCandidates.video.map(item => item.url);
  group.audioUrls = group.youtubeCandidates.audio.sort((a, b) => Number(b.bitrate || 0) - Number(a.bitrate || 0)).map(item => item.url);
  const complete = group.youtubeCandidates.complete[0];
  const video = group.youtubeCandidates.video[0];
  const audio = group.youtubeCandidates.audio[0];
  group.isYouTube = true;
  group.isYouTubeComplete = Boolean(complete);
  group.completeUrl = complete?.url || "";
  group.videoUrl = video?.url || "";
  group.audioUrl = audio?.url || "";
  group.url = complete?.url || video?.url || audio?.url || group.url;
  group.mime = complete?.mime || video?.mime || audio?.mime || group.mime || "";
  group.qualityLabel = complete?.qualityLabel || video?.qualityLabel || "";
  group.byteSize = complete?.byteSize || video?.byteSize || audio?.byteSize || 0;
  group.size = group.byteSize ? String(group.byteSize) : "";
  group.count = group.youtubeCandidates.complete.length + group.youtubeCandidates.video.length + group.youtubeCandidates.audio.length;
  group.lastSeen = Date.now();
}
function consolidateXGroups(state) {
  if (!isXStatus(state.page.url)) return;
  const primaryPostHls = state.groups.filter(group => group.type === "hls" && isXMediaCdn(group.url));
  if (primaryPostHls.length) state.groups = state.groups.filter(group => group.type !== "hls" || isXMediaCdn(group.url));
  const pageHlsGroups = primaryPostHls.length ? primaryPostHls : state.groups.filter(group => group.type === "hls");
  if (Number(state.page.playerCount) === 1 && pageHlsGroups.length) {
    const primary = pageHlsGroups.find(group => group.isXSinglePlayer) || pageHlsGroups[0];
    const variants = pageHlsGroups.flatMap(group => group.hlsUrls?.length ? group.hlsUrls : [{ url: group.url, byteSize: Number(group.byteSize || group.size || 0), isPlayer: group.isPlayer, currentTime: group.currentTime, playerArea: group.playerArea, mime: group.mime }]);
    primary.isXVideo = true;
    primary.isXSinglePlayer = true;
    primary.hlsUrls = [];
    for (const variant of variants) mergeXVariant(primary, variant.url, variant, variant.mime || "");
    state.groups = state.groups.filter(group => group === primary || group.type !== "hls");
    state.groups = state.groups.filter(group => group === primary || group.type !== "direct" || !isXMediaCdn(group.url));
    return;
  }
  const xGroups = state.groups.filter(group => ["hls", "direct"].includes(group.type) && xVideoKey(group.url));
  const byVideo = new Map();
  for (const group of xGroups) {
    const key = xVideoKey(group.url);
    const primary = byVideo.get(key);
    if (!primary) {
      byVideo.set(key, group);
      continue;
    }
    if (group.type === "hls" && primary.type !== "hls") byVideo.set(key, group);
  }
  for (const [key, primary] of byVideo) {
    const variants = xGroups.filter(group => xVideoKey(group.url) === key && group.type === "hls").flatMap(group => group.hlsUrls?.length ? group.hlsUrls : [{ url: group.url, byteSize: Number(group.byteSize || group.size || 0), isPlayer: group.isPlayer, currentTime: group.currentTime, playerArea: group.playerArea, mime: group.mime }]);
    if (primary.type === "hls") {
      primary.isXVideo = true;
      primary.hlsUrls = [];
      for (const variant of variants) mergeXVariant(primary, variant.url, variant, variant.mime || "");
    }
  }
  if (byVideo.size) {
    state.groups = state.groups.filter(group => {
      const key = xVideoKey(group.url);
      return !key || !["hls", "direct"].includes(group.type) || byVideo.get(key) === group;
    });
  }
}
function addMedia(tabId, url, type, details = {}) {
  if (type === "segment") return;
  const state = getState(tabId);
  if (type === "dash" && state.groups.some(group => group.isBilibiliComplete)) return;
  const normalized = normalizeUrl(url);
  const mime = headerValue(details.responseHeaders, "content-type") || details.mime || "";
  if (type === "dash") {
    const platform = details.platform === "youtube" ? "youtube" : "bilibili";
    const streamKind = details.streamKind || (mime.toLowerCase().startsWith("audio/") || bilibiliStreamKindFromUrl(url) === "audio" ? "audio" : "video");
    let dash = state.groups.find(group => group.type === "dash" && (group.platform || "bilibili") === platform);
    if (!dash) {
      const page = state.page;
      dash = { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, url: normalized, type: "dash", platform, title: page.title || `${sourceHost(page.url || details.documentUrl || url)} 媒体`, episode: page.episode || "", owner: page.owner || "", cover: page.cover || "", sourceUrl: page.url || details.documentUrl || "", host: page.host || sourceHost(page.url || details.documentUrl || url), bvid: page.bvid || "", tabId, size: "", mime: "video/mp4 + audio/mp4", videoUrl: "", audioUrl: "", videoUrls: [], audioUrls: [], count: 0, firstSeen: Date.now(), lastSeen: Date.now() };
      state.groups.unshift(dash);
    }
    if (platform === "youtube") {
      state.groups = state.groups.filter(group => group === dash || group.type !== "direct" || !/(^|\.)googlevideo\.com$/i.test(sourceHost(group.url)));
      mergeYouTubeFormat(dash, normalized, { ...details, streamKind }, mime);
      state.updatedAt = Date.now(); persist(tabId); return;
    }
    if (streamKind === "audio") { dash.audioUrl = normalized; dash.audioUrls = [...new Set([...(dash.audioUrls || []), normalized])]; } else { dash.videoUrl = normalized; dash.videoUrls = [...new Set([...(dash.videoUrls || []), normalized])]; dash.url = normalized; }
    dash.count += 1; dash.lastSeen = Date.now(); state.updatedAt = Date.now(); persist(tabId); return;
  }
  const existing = state.groups.find(group => group.url === normalized || group.variants?.some(variant => variant.url === normalized));
  if (existing) {
    if (existing.isWeiboVideo) { mergeWeiboVariant(existing, normalized, details, mime); persist(tabId); return; }
    const responseSize = Number(headerValue(details.responseHeaders, "content-length") || details.byteSize || 0);
    existing.lastSeen = Date.now();
    existing.count += 1;
    existing.isPlayer = existing.isPlayer || Boolean(details.isPlayer);
    existing.playerArea = Math.max(existing.playerArea || 0, Number(details.playerArea || 0));
    existing.duration = Math.max(existing.duration || 0, Number(details.duration || 0));
    existing.currentTime = Math.max(existing.currentTime || 0, Number(details.currentTime || 0));
    if (responseSize) { existing.byteSize = responseSize; existing.size = String(responseSize); }
    if (mime) existing.mime = mime;
    persist(tabId);
    return;
  }
  const page = state.page;
  const size = Number(headerValue(details.responseHeaders, "content-length") || details.byteSize || 0);
  const pageUrl = page.url || details.documentUrl || "";
  if (isXStatus(pageUrl) && type === "direct" && isXMediaCdn(normalized) && !xVideoKey(normalized)) return;
  if (isXStatus(pageUrl) && type === "hls") {
    if (isXMediaCdn(normalized)) state.groups = state.groups.filter(group => group.type !== "hls" || isXMediaCdn(group.url));
    else if (state.groups.some(group => group.type === "hls" && isXMediaCdn(group.url))) return;
  }
  if (isXStatus(pageUrl) && type === "hls" && Number(page.playerCount) === 1) {
    const singlePlayerGroup = state.groups.find(group => group.type === "hls" && group.isXSinglePlayer) || state.groups.find(group => group.type === "hls");
    if (singlePlayerGroup) {
      singlePlayerGroup.isXVideo = true;
      singlePlayerGroup.isXSinglePlayer = true;
      mergeXVariant(singlePlayerGroup, normalized, details, mime);
      state.groups = state.groups.filter(group => group === singlePlayerGroup || group.type !== "hls");
      state.updatedAt = Date.now();
      persist(tabId);
      return;
    }
  }
  const isGroupedWeiboVideo = type === "direct" && isWeiboDetail(pageUrl);
  const isGroupedXVideo = ["hls", "direct"].includes(type) && isXStatus(pageUrl) && Boolean(xVideoKey(normalized));
  if (isGroupedWeiboVideo) {
    const weiboGroup = state.groups.find(group => group.isWeiboVideo);
    if (weiboGroup) { mergeWeiboVariant(weiboGroup, normalized, details, mime); persist(tabId); return; }
  }
  if (isGroupedXVideo) {
    const xGroup = state.groups.find(group => group.isXVideo && xVideoKey(group.url) === xVideoKey(normalized));
    if (xGroup) {
      if (type !== "hls" && xGroup.type === "hls") { persist(tabId); return; }
      if (type === "hls" && xGroup.type !== "hls") { xGroup.type = "hls"; xGroup.hlsUrls = []; }
      if (type === "hls") mergeXVariant(xGroup, normalized, details, mime);
      persist(tabId);
      return;
    }
  }
  const group = { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, url: normalized, type, title: page.title || `${sourceHost(page.url || details.documentUrl || url)} 媒体`, episode: page.episode || "", owner: page.owner || "", cover: page.cover || "", sourceUrl: page.url || details.documentUrl || "", host: page.host || sourceHost(page.url || details.documentUrl || url), bvid: page.bvid || "", tabId, size: size ? String(size) : "", byteSize: size, isPlayer: Boolean(details.isPlayer), playerArea: Number(details.playerArea || 0), duration: Number(details.duration || 0), currentTime: Number(details.currentTime || 0), mime, count: 1, firstSeen: Date.now(), lastSeen: Date.now() };
  if (type === "hls" && isXStatus(pageUrl) && Number(page.playerCount) === 1) group.isXSinglePlayer = true;
  if (isGroupedWeiboVideo) { group.isWeiboVideo = true; group.variants = []; mergeWeiboVariant(group, normalized, details, mime); }
  if (isGroupedXVideo) {
    group.isXVideo = true;
    if (type === "hls") { group.hlsUrls = []; mergeXVariant(group, normalized, details, mime); }
  }
  state.groups.unshift(group);
  state.groups = state.groups.slice(0, MAX_GROUPS);
  state.updatedAt = Date.now();
  persist(tabId);
}
function clearTab(tabId) {
  const timer = biliResolveTimers.get(tabId);
  if (timer) clearTimeout(timer);
  biliResolveTimers.delete(tabId);
  tabState.set(tabId, emptyState(tabId));
  persist(tabId);
}
function canInjectIntoPage(url) { return /^https?:\/\//i.test(String(url || "")); }
async function readPageMediaSnapshot() {
  const meta = (name, property) => document.querySelector(`meta[name="${name}"], meta[property="${property}"]`)?.content || "";
  const text = selectors => document.querySelector(selectors)?.textContent?.replace(/\s+/g, " ").trim() || "";
  const absolute = value => { if (!value) return ""; try { return new URL(String(value), location.href).href; } catch { return ""; } };
  const host = location.hostname.replace(/^www\./, "");
  const initialState = window.__INITIAL_STATE__ || {};
  const initialPlayInfo = window.__playinfo__ || window.__PLAYINFO__ || {};
  const isBili = /(^|\.)bilibili\.com$|(^|\.)b23\.tv$/i.test(location.hostname) || Boolean((initialState.videoData?.bvid || initialState.bvid) && (initialPlayInfo.data || initialPlayInfo.result));
  const isWeiboPage = /(^|\.)weibo\.com$|(^|\.)weibo\.cn$/i.test(location.hostname);
  const videos = [...document.querySelectorAll("video, audio")];
  const items = [];
  const add = (url, details = {}) => {
    const resolved = absolute(url);
    if (/^https?:/i.test(resolved)) items.push({ url: resolved, ...details });
  };
  for (const media of videos) {
    const details = { isPlayer: true, playerArea: Math.max(0, media.clientWidth * media.clientHeight), duration: Number.isFinite(media.duration) ? media.duration : 0, currentTime: Number.isFinite(media.currentTime) ? media.currentTime : 0 };
    add(media.currentSrc || media.src || media.getAttribute("src"), details);
    for (const source of media.querySelectorAll("source")) add(source.src || source.getAttribute("src"), details);
  }
  for (const entry of performance.getEntriesByType("resource")) add(entry.name);

  let title = meta("", "og:title") || text("h1.video-title, h1[class*='video-title'], [class*='video-info'] h1, [class*='video-title']") || document.title;
  let owner = meta("author", "og:article:author") || text("[class*='up-name'],[class*='author'],[rel='author']");
  let cover = meta("", "og:image") || videos.find(media => media.poster)?.poster || "";
  let episode = "";
  let bvid = location.href.match(/BV[0-9A-Za-z]{10}/)?.[0] || "";

  if (isBili) {
    const initial = initialState;
    const video = initial.videoData || initial.videoInfo || {};
    title = video.title || initial.h1Title || title;
    owner = video.owner?.name || initial.upData?.name || owner;
    cover = video.pic || initial.pic || cover;
    bvid = video.bvid || initial.bvid || bvid;
    const part = Math.max(1, Number(new URL(location.href).searchParams.get("p") || 1));
    episode = video.pages?.find(page => Number(page.page) === part)?.part || video.pages?.[part - 1]?.part || "";
    const playInfo = initialPlayInfo;
    const playData = playInfo.data || playInfo.result || playInfo;
    const urls = value => [value?.baseUrl, value?.base_url, ...(value?.backupUrl || []), ...(value?.backup_url || [])].filter(Boolean);
    for (const stream of playData?.dash?.video || []) for (const url of urls(stream)) add(url, { type: "dash", streamKind: "video", mime: stream.mimeType || "video/mp4", width: Number(stream.width || 0), height: Number(stream.height || 0), qualityLabel: stream.height ? `${stream.height}P` : "" });
    for (const stream of playData?.dash?.audio || []) for (const url of urls(stream)) add(url, { type: "dash", streamKind: "audio", mime: stream.mimeType || "audio/mp4" });
    for (const stream of playData?.durl || []) add(stream.url, { type: "direct", mime: "video/mp4", byteSize: Number(stream.size || 0), qualityLabel: playData.quality ? `${playData.quality}P` : "" });
  }

  if (isWeiboPage) {
    const parsed = new URL(location.href);
    const videoId = decodeURIComponent(parsed.pathname).match(/\/tv\/show\/([^/?#]+)/i)?.[1] || parsed.searchParams.get("fid") || "";
    if (videoId) {
      try {
        const response = await fetch(`/tv/api/component?page=/tv/show/${encodeURIComponent(videoId)}`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ data: JSON.stringify({ Component_Play_Playinfo: { oid: videoId } }) })
        });
        if (response.ok) {
          const payload = await response.json();
          const info = payload?.data?.Component_Play_Playinfo;
          if (info) {
            title = info.title || info.text || title;
            owner = info.author || info.nickname || owner;
            cover = absolute(info.cover_image) || cover;
            for (const [qualityLabel, url] of Object.entries(info.urls || {})) add(url, { type: "direct", qualityLabel, isPlayer: true });
            add(info.stream_url, { type: "direct", qualityLabel: "播放器地址", isPlayer: true });
          }
        }
      } catch { /* Network sniffing and DOM URLs remain available as fallback. */ }
    }
  }

  const seen = new Set();
  return {
    context: { url: location.href, pageTitle: document.title, title, videoTitle: title, owner, cover, bvid, episode, host, isBilibili: isBili, isWeibo: isWeiboPage, playerCount: videos.filter(media => Math.max(0, media.clientWidth * media.clientHeight) >= 20000).length },
    items: items.filter(item => item.url && !seen.has(item.url) && seen.add(item.url))
  };
}
function ingestPageSnapshot(tabId, snapshot, documentUrl) {
  if (!snapshot) return 0;
  const state = getState(tabId);
  const context = snapshot.context || {};
  state.page = {
    ...state.page,
    ...context,
    url: context.url || documentUrl || state.page.url,
    title: cleanTitle(context.title || context.videoTitle || state.page.title, sourceHost(context.url || documentUrl)),
    videoTitle: cleanTitle(context.videoTitle || context.title || state.page.videoTitle, sourceHost(context.url || documentUrl)),
    owner: cleanTitle(context.owner || state.page.owner, ""),
    episode: context.isWeibo ? "" : cleanTitle(context.episode || state.page.episode, "")
  };
  persist(tabId);
  let found = 0;
  for (const item of snapshot.items || []) {
    const type = item.type || classifyMediaUrl(item.url, { ...item, documentUrl: state.page.url });
    if (!type) continue;
    addMedia(tabId, item.url, type, { ...item, documentUrl: state.page.url, responseHeaders: [] });
    found += 1;
  }
  return found;
}
async function collectSnapshotFromTab(tab) {
  if (!canInjectIntoPage(tab?.url)) return 0;
  const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: readPageMediaSnapshot });
  return ingestPageSnapshot(tab.id, results?.[0]?.result, tab.url || "");
}
async function collectFromTab(tab) {
  if (tab?.id === undefined) throw new Error("没有找到当前标签页");
  let response = null;
  let initialError = null;
  try {
    response = await chrome.tabs.sendMessage(tab.id, { type: "collect-now" });
  } catch (error) {
    initialError = error;
  }
  if (!canInjectIntoPage(tab.url)) {
    if (response) return response;
    throw new Error("当前页面受浏览器保护，无法注入嗅探脚本");
  }
  let snapshotFound = 0;
  try { snapshotFound = await collectSnapshotFromTab(tab); } catch { /* Some protected frames reject main-world snapshots. */ }
  const staleContent = response && response.contentProtocol !== CONTENT_PROTOCOL_VERSION;
  if (!response && !snapshotFound) {
    if (/^https?:\/\/(?:[^/]+\.)?youtube\.com\//i.test(tab.url || "")) await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["youtube-main.js"], world: "MAIN" });
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["shared.js", "content.js"] });
      response = await chrome.tabs.sendMessage(tab.id, { type: "collect-now" });
    } catch (error) {
      if (!snapshotFound) throw initialError || error;
    }
  }
  return { ok: response?.ok !== false || snapshotFound > 0, found: Number(response?.found || 0) + snapshotFound, recovered: staleContent || Boolean(initialError), contentProtocol: response?.contentProtocol || 0 };
}
function playUrls(value) { return [...new Set([value?.baseUrl, value?.base_url, ...(value?.backupUrl || []), ...(value?.backup_url || [])].filter(Boolean))]; }
function playUrl(value) { return playUrls(value)[0] || ""; }
function bvidFromUrl(url) { return String(url || "").match(/BV[0-9A-Za-z]{10}/)?.[0] || ""; }
async function installBilibiliHeaderRule() {
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [1001], addRules: [{ id: 1001, priority: 1, action: { type: "modifyHeaders", requestHeaders: [{ header: "Referer", operation: "set", value: "https://www.bilibili.com/" }] }, condition: { urlFilter: "||bilivideo.com/" } }] });
}
function validReferer(value) {
  try {
    const referer = new URL(value);
    if (!["http:", "https:"].includes(referer.protocol)) return "";
    referer.hash = "";
    return referer.toString();
  } catch { return ""; }
}
async function installScopedDownloadHeaderRule(url, sourceUrl = "") {
  const host = new URL(url).hostname;
  const referer = validReferer(sourceUrl);
  const origin = referer ? new URL(referer).origin : "";
  const requestHeaders = referer ? [{ header: "Referer", operation: "set", value: referer }, { header: "Origin", operation: "set", value: origin }] : [];
  const addRules = requestHeaders.length ? [{ id: 2001, priority: 2, action: { type: "modifyHeaders", requestHeaders }, condition: { requestDomains: [host] } }] : [];
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [2001], addRules });
}
async function assertMediaResponse(url) {
  const response = await fetch(url);
  const mime = (response.headers.get("content-type") || "").toLowerCase();
  const finalUrl = response.url || url;
  await response.body?.cancel();
  if (!response.ok || mime.includes("text/html")) throw new Error(`${sourceHost(url)} 返回了网页错误页（HTTP ${response.status}），请重新扫描后再试`);
  if (mime && !mime.startsWith("video/") && !mime.startsWith("audio/") && !mime.includes("octet-stream") && !mime.includes("mpegurl")) throw new Error(`下载地址返回了非媒体内容：${mime}`);
  return finalUrl;
}
async function firstUsableMediaUrl(urls, label, sourceUrl = "") {
  let lastError;
  for (const url of [...new Set((urls || []).filter(Boolean))]) {
    try {
      await installScopedDownloadHeaderRule(url, sourceUrl);
      const finalUrl = await assertMediaResponse(url);
      await installScopedDownloadHeaderRule(finalUrl, sourceUrl);
      return finalUrl;
    } catch (error) { lastError = error; }
  }
  throw new Error(`${label}的所有 CDN 地址均不可用：${lastError?.message || "未知错误"}`);
}
async function ensureOffscreenDocument() {
  const documentUrl = chrome.runtime.getURL("offscreen.html");
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [documentUrl] });
  if (contexts.length) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: "读取需要来源页请求头的公开媒体，并生成可供 Chrome 保存的临时文件"
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}
async function prepareMediaBlob(url, kind = "direct") {
  await ensureOffscreenDocument();
  const result = await chrome.runtime.sendMessage({ target: "offscreen", type: "prepare-media-blob", url, kind });
  if (!result?.ok || !result.blobUrl) throw new Error(result?.error || "无法准备视频文件");
  return result;
}
async function startDownload(options) {
  try { return await chrome.downloads.download(options); }
  catch (error) {
    if (!/filename/i.test(error?.message || "")) throw error;
    const extension = options.filename?.match(/\.([a-z0-9]+)$/i)?.[1] || "mp4";
    return chrome.downloads.download({ ...options, filename: `丸酱媒体嗅探助手/视频-${Date.now()}.${extension}` });
  }
}
function releaseMediaBlob(downloadId) {
  const prepared = blobDownloads.get(downloadId);
  if (!prepared) return;
  blobDownloads.delete(downloadId);
  chrome.runtime.sendMessage({ target: "offscreen", type: "release-media-blob", blobUrl: prepared.blobUrl, storageName: prepared.storageName || "" }).catch(() => {});
}
async function rejectHtmlDownload(id) {
  const [item] = await chrome.downloads.search({ id });
  if (!item) return;
  const isHtml = /text\/html/i.test(item.mime || "") || /\.html?$/i.test(item.filename || "");
  if (!isHtml) return;
  downloadFailures.set(id, "下载地址返回了网页错误页，插件已安全取消。请重新扫描后再试");
  setTimeout(() => downloadFailures.delete(id), 30000);
  await chrome.downloads.cancel(id).catch(() => {});
  await chrome.downloads.erase({ id }).catch(() => {});
  protectedDownloads.delete(id);
}
function protectMediaDownload(id) { protectedDownloads.add(id); rejectHtmlDownload(id).catch(() => {}); }
function youtubeFileExtension(group, kind) {
  const candidate = group.youtubeCandidates?.[kind]?.[0];
  const mime = String(candidate?.mime || "").toLowerCase();
  if (mime.includes("webm")) return "webm";
  if (kind === "audio") return "m4a";
  return "mp4";
}
async function resolveBilibili(tabId) {
  const state = getState(tabId); const page = state.page;
  if (!page.isBilibili || !page.bvid || state.biliResolving === page.bvid || state.biliResolvedFor === page.bvid) return;
  const observedDash = state.groups.find(group => group.type === "dash" && (group.platform || "bilibili") === "bilibili");
  if (observedDash?.videoUrl && observedDash?.audioUrl) { state.biliResolvedFor = page.bvid; state.biliError = ""; persist(tabId); return; }
  state.biliResolving = page.bvid;
  try {
    const view = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(page.bvid)}`, { credentials: "include" }).then(response => response.json());
    if (view.code !== 0 || !view.data?.pages?.length) throw new Error(view.message || "未找到当前视频信息");
    const part = Math.max(1, Number(new URL(page.url).searchParams.get("p") || 1));
    const episode = view.data.pages.find(item => item.page === part) || view.data.pages[0];
    state.page = { ...state.page, title: view.data.title || state.page.title, videoTitle: view.data.title || state.page.videoTitle, owner: view.data.owner?.name || state.page.owner, cover: view.data.pic || state.page.cover, episode: episode.part || state.page.episode };
    const compat = await fetch(`https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(page.bvid)}&cid=${episode.cid}&qn=80&fnval=0&fnver=0&fourk=0`, { credentials: "include" }).then(response => response.json());
    if (compat.code === 0 && compat.data?.durl?.[0]?.url) {
      state.groups = state.groups.filter(group => group.type !== "dash");
      addMedia(tabId, compat.data.durl[0].url, "direct", { documentUrl: state.page.url, responseHeaders: [{ name: "content-type", value: "video/mp4" }] });
      const complete = state.groups.find(group => group.url === normalizeUrl(compat.data.durl[0].url)); if (complete) { complete.isBilibiliComplete = true; complete.qualityLabel = compat.data.accept_description?.[compat.data.accept_quality?.indexOf(compat.data.quality)] || `${compat.data.quality || 64}P`; }
    } else {
      const play = await fetch(`https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(page.bvid)}&cid=${episode.cid}&fnval=4048&fourk=1`, { credentials: "include" }).then(response => response.json());
      if (play.code !== 0) throw new Error(play.message || "未取得播放地址");
      const data = play.data || {}; const videos = data.dash?.video || []; const video = videos.find(item => /avc/i.test(item.codecs || "")) || videos[0]; const audio = data.dash?.audio?.[0];
      if (video || audio) {
      const source = state.page.url;
      if (video && playUrl(video)) addMedia(tabId, playUrl(video), "dash", { documentUrl: source, responseHeaders: [{ name: "content-type", value: "video/mp4" }] });
      if (audio && playUrl(audio)) addMedia(tabId, playUrl(audio), "dash", { documentUrl: source, responseHeaders: [{ name: "content-type", value: "audio/mp4" }] });
      const dash = state.groups.find(group => group.type === "dash"); if (dash) { dash.videoUrls = playUrls(video); dash.audioUrls = playUrls(audio); dash.videoUrl = dash.videoUrls[0] || ""; dash.audioUrl = dash.audioUrls[0] || ""; dash.url = dash.videoUrl || dash.audioUrl; }
      } else throw new Error("当前视频没有可下载的公开媒体流");
    }
    state.biliResolvedFor = page.bvid;
  } catch (error) {
    const hasObservedMedia = state.groups.some(group => group.type === "dash" && (group.platform || "bilibili") === "bilibili" && (group.videoUrl || group.audioUrl));
    state.biliError = hasObservedMedia ? "" : error.message || "B站播放地址解析失败";
  }
  finally { state.biliResolving = ""; persist(tabId); }
}
function scheduleBilibiliResolve(tabId) {
  const previous = biliResolveTimers.get(tabId);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(() => {
    biliResolveTimers.delete(tabId);
    resolveBilibili(tabId).catch(() => {});
  }, 1500);
  biliResolveTimers.set(tabId, timer);
}

chrome.webRequest.onResponseStarted.addListener(details => {
  const type = classifyMediaUrl(details.url, details);
  if (type) addMedia(details.tabId, details.url, type, details);
}, { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] }, ["responseHeaders"]);

chrome.webNavigation.onCommitted.addListener(details => { if (details.frameId === 0) clearTab(details.tabId); });
chrome.tabs.onRemoved.addListener(tabId => { const timer = biliResolveTimers.get(tabId); if (timer) clearTimeout(timer); biliResolveTimers.delete(tabId); tabState.delete(tabId); chrome.storage.session.remove(`tab:${tabId}`); });
chrome.runtime.onInstalled.addListener(() => installBilibiliHeaderRule().catch(() => {}));
chrome.runtime.onStartup.addListener(() => installBilibiliHeaderRule().catch(() => {}));
installBilibiliHeaderRule().catch(() => {});
setMaruActionIcon().catch(() => {});
chrome.downloads.onChanged.addListener(delta => {
  if (!protectedDownloads.has(delta.id)) return;
  if (/text\/html/i.test(delta.mime?.current || "") || /\.html?$/i.test(delta.filename?.current || "")) rejectHtmlDownload(delta.id).catch(() => {});
  if (delta.state?.current === "complete" || delta.error?.current) { protectedDownloads.delete(delta.id); releaseMediaBlob(delta.id); }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (message.type === "page-context" && tabId !== undefined) {
    const state = getState(tabId); state.page = { ...state.page, ...message.context }; state.groups.forEach(group => { group.title = state.page.title || group.title; group.owner = state.page.owner || group.owner; group.cover = state.page.cover || group.cover; group.sourceUrl = state.page.url || group.sourceUrl; group.host = state.page.host || group.host; group.bvid = state.page.isWeibo ? "" : state.page.bvid || group.bvid; group.episode = state.page.isWeibo ? "" : state.page.episode || group.episode; }); consolidateWeiboGroups(state); consolidateXGroups(state); state.updatedAt = Date.now(); persist(tabId); if (state.page.isBilibili) scheduleBilibiliResolve(tabId); sendResponse({ ok: true }); return false;
  }
  if (message.type === "media-hints" && tabId !== undefined) { message.items?.forEach(item => addMedia(tabId, item.url, item.type || classifyMediaUrl(item.url), { ...item, documentUrl: message.documentUrl, responseHeaders: [] })); sendResponse({ ok: true, count: message.items?.length || 0 }); return false; }
  if (message.type === "get-current") { chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => { if (tab?.id === undefined) return sendResponse(emptyState(-1)); await sessionReady; let state = getState(tab.id); const tabUrl = tab.url || state.page.url; state.page = { ...state.page, url: tabUrl, pageTitle: state.page.pageTitle || tab.title || "", title: state.page.title || tab.title || "", host: state.page.host || sourceHost(tabUrl), bvid: state.page.bvid || bvidFromUrl(tabUrl), isBilibili: state.page.isBilibili || isBilibili(tabUrl) }; if (!downloadableCount(state)) { try { await collectFromTab(tab); await new Promise(resolve => setTimeout(resolve, 100)); state = getState(tab.id); } catch { /* Restricted browser pages cannot be scanned. */ } } await resolveBilibili(tab.id); sendResponse(getState(tab.id)); }).catch(error => sendResponse({ ...emptyState(-1), error: error.message || "读取当前页面失败" })); return true; }
  if (message.type === "capture-current") { chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => { const result = await collectFromTab(tab); sendResponse(result || { ok: true, found: 0 }); }).catch(error => sendResponse({ ok: false, error: error.message || "重新扫描当前页面失败" })); return true; }
  if (message.type === "clear-current") { if (message.tabId !== undefined) clearTab(message.tabId); sendResponse({ ok: true }); return false; }
  if (message.type === "download-status") { sendResponse({ failure: downloadFailures.get(message.id) || "" }); return false; }
  if (message.type === "download") {
    const group = message.group;
    const extension = group.isBilibiliComplete ? "mp4" : group.type === "hls" ? "ts" : (group.url.match(/\.([a-z0-9]+)(?:$|[?#])/i)?.[1] || "mp4");
    chrome.storage.sync.get({ prefix: "", saveAs: true }).then(async settings => {
      const prefix = settings.prefix ? `${safePathComponent(settings.prefix, "丸酱媒体嗅探助手", 60)}/` : "丸酱媒体嗅探助手/";
      const base = `${prefix}${safeFileName(group.title, group.episode)}`;
      const sourceUrl = group.sourceUrl || "";
      if (group.type === "dash") {
        if (group.isYouTube) {
          const kind = group.isYouTubeComplete && message.streamKind !== "audio" ? "complete" : message.streamKind === "audio" ? "audio" : "video";
          const candidates = kind === "complete" ? group.completeUrls : kind === "audio" ? group.audioUrls : group.videoUrls;
          const url = candidates?.[0];
          if (!url) throw new Error(kind === "audio" ? "没有找到 YouTube 音频流" : "没有找到 YouTube 视频流");
          await installScopedDownloadHeaderRule(url, sourceUrl);
          const outputExtension = youtubeFileExtension(group, kind);
          const suffix = kind === "complete" ? outputExtension : `${kind}.${outputExtension}`;
          const id = await startDownload({ url, filename: `${base}.${suffix}`, saveAs: settings.saveAs });
          protectMediaDownload(id);
          return { ids: [id], streams: 1, kind, complete: kind === "complete", extension: outputExtension };
        }
        const kind = message.streamKind === "audio" ? "audio" : "video";
        const candidates = kind === "audio" ? (group.audioUrls?.length ? group.audioUrls : [group.audioUrl]) : (group.videoUrls?.length ? group.videoUrls : [group.videoUrl]);
        const url = await firstUsableMediaUrl(candidates, kind === "audio" ? "音频流" : "视频流", sourceUrl);
        const id = await startDownload({ url, filename: `${base}.${kind}.m4s`, saveAs: false });
        protectMediaDownload(id);
        return { ids: [id], streams: 1, kind };
      }
      const candidates = group.type === "hls" && group.hlsUrls?.length ? group.hlsUrls.map(item => item.url) : [group.url];
      const url = await firstUsableMediaUrl(candidates, "媒体流", sourceUrl);
      const usePreparedFile = group.isBilibiliComplete || group.type === "direct" || group.type === "hls";
      if (usePreparedFile) {
        const prepared = await prepareMediaBlob(url, group.type);
        const outputExtension = prepared.extension || extension;
        try {
          const id = await startDownload({ url: prepared.blobUrl, filename: `${base}.${outputExtension}`, saveAs: group.isBilibiliComplete ? false : settings.saveAs });
          blobDownloads.set(id, prepared);
          protectMediaDownload(id);
          return { ids: [id], streams: 1, complete: Boolean(group.isBilibiliComplete), preparedBytes: prepared.size || 0, extension: outputExtension };
        } catch (error) {
          chrome.runtime.sendMessage({ target: "offscreen", type: "release-media-blob", blobUrl: prepared.blobUrl, storageName: prepared.storageName || "" }).catch(() => {});
          throw error;
        }
      }
      const id = await startDownload({ url, filename: `${base}.${extension}`, saveAs: settings.saveAs });
      protectMediaDownload(id);
      return { ids: [id], streams: 1, complete: false };
    }).then(result => sendResponse({ ok: true, ...result })).catch(error => sendResponse({ ok: false, error: error.message || "下载失败" }));
    return true;
  }
  if (message.type === "open-source") { chrome.tabs.create({ url: message.url }); sendResponse({ ok: true }); return false; }
  if (message.type === "copy") { sendResponse({ ok: true }); return false; }
});
