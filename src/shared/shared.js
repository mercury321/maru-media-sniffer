const MEDIA_EXTENSIONS = /\.(mp4|webm|mov|m4v|mp3|m4a|aac|wav)(?:$|[?#])/i;
const HLS_EXTENSIONS = /\.m3u8(?:$|[?#])/i;
const SEGMENT_EXTENSIONS = /\.(ts|m4s|aac|cmfa|cmfv)(?:$|[?#])/i;

function headerValue(headers, name) {
  return headers?.find(header => header.name?.toLowerCase() === name.toLowerCase())?.value || "";
}

function classifyMediaUrl(url, details = {}) {
  if (!url || !/^https?:/i.test(url)) return null;
  const mime = (headerValue(details.responseHeaders, "content-type") || details.mime || "").toLowerCase();
  try {
    const parsed = new URL(url);
    if (/(^|\.)googlevideo\.com$/i.test(parsed.hostname) && /\/videoplayback$/i.test(parsed.pathname)) return "segment";
  } catch { /* Continue with generic media checks. */ }
  if (HLS_EXTENSIONS.test(url)) return "hls";
  if (MEDIA_EXTENSIONS.test(url)) return "direct";
  if (SEGMENT_EXTENSIONS.test(url)) {
    if (isBilibiliMediaRequest(url, details)) return "dash";
    return "segment";
  }
  if (mime.includes("mpegurl") || mime.includes("m3u8")) return "hls";
  if (mime.startsWith("video/") || mime.startsWith("audio/")) return "direct";
  if (details.type === "media") return "direct";
  return null;
}

function cleanTitle(value, fallback = "未命名视频") {
  const result = String(value || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  return (result || fallback).slice(0, 120);
}

function truncateUtf8(value, maxBytes) {
  const encoder = new TextEncoder();
  let result = "";
  let bytes = 0;
  for (const character of String(value || "")) {
    const length = encoder.encode(character).length;
    if (bytes + length > maxBytes) break;
    result += character;
    bytes += length;
  }
  return result;
}

function safePathComponent(value, fallback = "未命名视频", maxBytes = 180) {
  let result = String(value || "").normalize("NFC").replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, " ").replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim().replace(/[. ]+$/g, "");
  if (!result) result = fallback;
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result)) result = `_${result}`;
  return truncateUtf8(result, maxBytes) || fallback;
}

function safeFileName(title, episode = "") {
  const base = safePathComponent(title, "未命名视频", 165);
  const part = safePathComponent(episode, "", 60);
  return safePathComponent(`${base}${part && part !== base ? ` - ${part}` : ""}`, "未命名视频", 190);
}

function sourceHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "未知网站"; }
}

function isBilibili(url) {
  try { return /(^|\.)bilibili\.com$|(^|\.)b23\.tv$/i.test(new URL(url).hostname); } catch { return false; }
}

function isBilibiliMediaRequest(url, details = {}) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (/(^|\.)(?:bilivideo\.com|bilivideo\.cn)$/i.test(host)) return true;
    const pageUrl = details.documentUrl || details.initiator || details.originUrl || "";
    return isBilibili(pageUrl) && /\.(?:m4s|cmfa|cmfv)(?:$|[?#])/i.test(url) && /\/upgcxcode\//i.test(parsed.pathname);
  } catch { return false; }
}

function bilibiliStreamKindFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    return /-(?:30216|30232|30250|30251|30280|30300)\.m4s$/i.test(path) || /(?:audio|sound)[^/]*\.m4s$/i.test(path) ? "audio" : "video";
  } catch { return "video"; }
}

function isWeibo(url) {
  try { return /(^|\.)weibo\.com$|(^|\.)weibo\.cn$/i.test(new URL(url).hostname); } catch { return false; }
}

function isWeiboDetail(url) {
  try {
    const parsed = new URL(url);
    if (!isWeibo(url)) return false;
    return /^\/\d+\/[0-9A-Za-z]+\/?$/.test(parsed.pathname)
      || /^\/detail\/\d+\/?$/.test(parsed.pathname)
      || /^\/status\/\d+\/?$/.test(parsed.pathname)
      || /^\/tv\/show\/[^/]+\/?$/i.test(parsed.pathname)
      || (/^\/show\/?$/i.test(parsed.pathname) && Boolean(parsed.searchParams.get("fid")));
  } catch { return false; }
}

function isX(url) {
  try { return /(^|\.)(?:x\.com|twitter\.com)$/i.test(new URL(url).hostname); } catch { return false; }
}

function isXStatus(url) {
  try {
    if (!isX(url)) return false;
    const path = new URL(url).pathname;
    return /^(?:\/[A-Za-z0-9_]+)?\/status\/\d+(?:\/(?:video|photo)\/\d+)?\/?$/.test(path) || /^\/i\/status\/\d+(?:\/(?:video|photo)\/\d+)?\/?$/.test(path);
  } catch { return false; }
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch { return url; }
}
