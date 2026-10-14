const mediaBlobs = new Map();

async function checkedResponse(url) {
  const response = await fetch(url);
  const mime = (response.headers.get("content-type") || "").toLowerCase();
  if (!response.ok || mime.includes("text/html")) {
    await response.body?.cancel();
    throw new Error(`视频服务器拒绝读取：HTTP ${response.status}`);
  }
  return response;
}

function attributes(value) {
  const result = {};
  const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
  let match;
  while ((match = pattern.exec(value))) result[match[1].toUpperCase()] = match[2].replace(/^"|"$/g, "");
  return result;
}

async function resolveMediaPlaylist(url) {
  let playlistUrl = url;
  for (let depth = 0; depth < 4; depth += 1) {
    const response = await checkedResponse(playlistUrl);
    const text = await response.text();
    if (!text.includes("#EXTM3U")) throw new Error("HLS 地址没有返回有效播放列表");
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const variants = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].startsWith("#EXT-X-STREAM-INF:")) continue;
      const info = attributes(lines[index].slice(lines[index].indexOf(":") + 1));
      const next = lines.slice(index + 1).find(line => !line.startsWith("#"));
      if (next) variants.push({ bandwidth: Number(info.BANDWIDTH || 0), url: new URL(next, playlistUrl).toString() });
    }
    if (!variants.length) return { playlistUrl, text, lines };
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    playlistUrl = variants[0].url;
  }
  throw new Error("HLS 主播放列表嵌套层级过深");
}

function sequenceIv(sequence) {
  const iv = new Uint8Array(16);
  new DataView(iv.buffer).setBigUint64(8, BigInt(sequence));
  return iv;
}

function explicitIv(value, sequence) {
  if (!value) return sequenceIv(sequence);
  const hex = value.replace(/^0x/i, "").padStart(32, "0").slice(-32);
  return Uint8Array.from(hex.match(/.{2}/g).map(pair => Number.parseInt(pair, 16)));
}

async function fetchBytes(url, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await checkedResponse(url);
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  throw lastError;
}

const keyCache = new Map();
async function decryptSegment(segment, bytes) {
  if (!segment.key) return bytes;
  if (segment.key.method !== "AES-128") throw new Error(`不支持 ${segment.key.method} 加密的 HLS（可能是 DRM）`);
  if (!keyCache.has(segment.key.url)) {
    keyCache.set(segment.key.url, fetchBytes(segment.key.url).then(raw => {
      if (raw.byteLength !== 16) throw new Error("HLS 解密密钥长度无效");
      return crypto.subtle.importKey("raw", raw, { name: "AES-CBC" }, false, ["decrypt"]);
    }));
  }
  const key = await keyCache.get(segment.key.url);
  const iv = explicitIv(segment.key.iv, segment.sequence);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, bytes));
}

function parseSegments(playlistUrl, lines) {
  let mediaSequence = 0;
  let segmentIndex = 0;
  let currentKey = null;
  let initMapUrl = "";
  const segments = [];
  for (const line of lines) {
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) mediaSequence = Number(line.split(":")[1] || 0);
    else if (line.startsWith("#EXT-X-BYTERANGE:")) throw new Error("暂不支持按字节范围切分的 HLS");
    else if (line.startsWith("#EXT-X-MAP:")) {
      const map = attributes(line.slice(line.indexOf(":") + 1));
      if (map.BYTERANGE) throw new Error("暂不支持按字节范围初始化的 HLS");
      initMapUrl = map.URI ? new URL(map.URI, playlistUrl).toString() : "";
    } else if (line.startsWith("#EXT-X-KEY:")) {
      const key = attributes(line.slice(line.indexOf(":") + 1));
      if (key.METHOD === "NONE") currentKey = null;
      else if (key.METHOD === "AES-128" && key.URI && (!key.KEYFORMAT || key.KEYFORMAT === "identity")) currentKey = { method: key.METHOD, url: new URL(key.URI, playlistUrl).toString(), iv: key.IV || "" };
      else throw new Error(`不支持 ${key.METHOD || "未知"} 加密的 HLS（可能是 DRM）`);
    } else if (line && !line.startsWith("#")) {
      segments.push({ url: new URL(line, playlistUrl).toString(), key: currentKey ? { ...currentKey } : null, sequence: mediaSequence + segmentIndex });
      segmentIndex += 1;
    }
  }
  if (!segments.length) throw new Error("HLS 播放列表中没有找到视频分片");
  return { segments, initMapUrl };
}

function detectExtension(bytes, hasInitMap) {
  if (hasInitMap) return { extension: "mp4", mime: "video/mp4" };
  if (bytes[0] === 0x47 && bytes.length > 188 && bytes[188] === 0x47) return { extension: "ts", mime: "video/mp2t" };
  const signature = String.fromCharCode(...bytes.slice(4, 8));
  if (signature === "ftyp") return { extension: "mp4", mime: "video/mp4" };
  return { extension: "ts", mime: "video/mp2t" };
}

function containsServerError(bytes) {
  const sample = new TextDecoder().decode(bytes.slice(0, 512)).trim();
  return /^(?:<!doctype|<html|<\?xml|\{[\s\S]*?(?:error|message)|accessdenied|forbidden|unauthorized)/i.test(sample);
}

async function prepareHls(url) {
  const resolved = await resolveMediaPlaylist(url);
  const { segments, initMapUrl } = parseSegments(resolved.playlistUrl, resolved.lines);
  const root = await navigator.storage.getDirectory();
  const storageName = `sniffer-hls-${Date.now()}-${crypto.randomUUID()}.media`;
  const handle = await root.getFileHandle(storageName, { create: true });
  const writable = await handle.createWritable();
  try {
    if (initMapUrl) await writable.write(await fetchBytes(initMapUrl));
    const first = await decryptSegment(segments[0], await fetchBytes(segments[0].url));
    if (containsServerError(first)) throw new Error("HLS 分片返回了服务器错误页，请重新扫描后再试");
    const format = detectExtension(first, Boolean(initMapUrl));
    await writable.write(first);
    chrome.runtime.sendMessage({ type: "hls-progress", current: 1, total: segments.length, percent: Math.max(1, Math.floor(100 / segments.length)) }).catch(() => {});
    const concurrency = 6;
    for (let start = 1; start < segments.length; start += concurrency) {
      const batch = segments.slice(start, start + concurrency);
      const buffers = await Promise.all(batch.map(async segment => decryptSegment(segment, await fetchBytes(segment.url))));
      for (const bytes of buffers) await writable.write(bytes);
      const current = Math.min(start + batch.length, segments.length);
      chrome.runtime.sendMessage({ type: "hls-progress", current, total: segments.length, percent: Math.floor((current / segments.length) * 100) }).catch(() => {});
    }
    await writable.close();
    const file = await handle.getFile();
    const typedFile = new Blob([file], { type: format.mime });
    const blobUrl = URL.createObjectURL(typedFile);
    mediaBlobs.set(blobUrl, { storageName });
    return { ok: true, blobUrl, storageName, size: file.size, mime: format.mime, extension: format.extension, segments: segments.length };
  } catch (error) {
    await writable.abort().catch(() => {});
    await root.removeEntry(storageName).catch(() => {});
    throw error;
  }
}

async function prepareDirect(url) {
  const response = await checkedResponse(url);
  const mime = (response.headers.get("content-type") || "").toLowerCase();
  if (mime && !mime.startsWith("video/") && !mime.startsWith("audio/") && !mime.includes("octet-stream")) {
    await response.body?.cancel();
    throw new Error(`视频地址返回了非媒体内容：${mime}`);
  }
  const blob = await response.blob();
  if (!blob.size) throw new Error("读取到的视频文件为空");
  const blobUrl = URL.createObjectURL(blob);
  mediaBlobs.set(blobUrl, {});
  return { ok: true, blobUrl, size: blob.size, mime: blob.type };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== "offscreen") return false;
  if (message.type === "release-media-blob") {
    const record = mediaBlobs.get(message.blobUrl);
    if (record) {
      mediaBlobs.delete(message.blobUrl);
      URL.revokeObjectURL(message.blobUrl);
    }
    const storageName = message.storageName || record?.storageName;
    if (storageName) navigator.storage.getDirectory().then(root => root.removeEntry(storageName).catch(() => {}));
    sendResponse({ ok: true });
    return false;
  }
  if (message.type !== "prepare-media-blob") return false;
  const task = message.kind === "hls" ? prepareHls(message.url) : prepareDirect(message.url);
  task.then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message || "视频文件准备失败" }));
  return true;
});
