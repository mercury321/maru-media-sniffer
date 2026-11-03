(() => {
  const BRIDGE_VERSION = 4;
  if (window.__maruYouTubeBridgeVersion === BRIDGE_VERSION && typeof window.__maruYouTubeEmitFormats === "function") {
    window.__maruYouTubeEmitFormats();
    return;
  }

  window.__maruYouTubeBridgeVersion = BRIDGE_VERSION;
  let pending = null;

  const currentVideoId = response => response?.videoDetails?.videoId || new URL(location.href).searchParams.get("v") || "";
  const formatUrl = format => {
    if (/^https?:/i.test(format?.url || "")) return format.url;
    if (!format?.signatureCipher) return "";
    const cipher = new URLSearchParams(format.signatureCipher);
    if (cipher.get("s")) return "";
    const url = cipher.get("url") || "";
    if (!/^https?:/i.test(url)) return "";
    const signature = cipher.get("sig") || cipher.get("signature");
    if (!signature) return url;
    const signed = new URL(url);
    signed.searchParams.set(cipher.get("sp") || "signature", signature);
    return signed.toString();
  };
  const summarize = (response, source) => {
    const streaming = response?.streamingData || {};
    const rawFormats = [...(streaming.formats || []), ...(streaming.adaptiveFormats || [])];
    const seen = new Set();
    const formats = rawFormats.map(format => {
      const url = formatUrl(format);
      const mimeType = format.mimeType || "";
      const hasVideo = mimeType.startsWith("video/");
      const hasAudio = mimeType.startsWith("audio/") || Boolean(format.audioQuality);
      let contentLength = Number(format.contentLength || 0);
      if (!contentLength && url) {
        try { contentLength = Number(new URL(url).searchParams.get("clen") || 0); } catch { /* Keep unknown length. */ }
      }
      return {
        url,
        mimeType,
        itag: format.itag,
        bitrate: format.bitrate,
        contentLength,
        width: format.width,
        height: format.height,
        qualityLabel: format.qualityLabel,
        hasVideo,
        hasAudio,
        isProgressive: hasVideo && hasAudio
      };
    }).filter(format => /^https?:/i.test(format.url) && !seen.has(format.url) && seen.add(format.url));
    const thumbnails = response?.videoDetails?.thumbnail?.thumbnails || [];
    return {
      formats,
      source,
      status: response?.playabilityStatus?.status || (formats.length ? "OK" : "UNKNOWN"),
      reason: response?.playabilityStatus?.reason || "",
      encryptedCount: rawFormats.filter(format => format.signatureCipher && new URLSearchParams(format.signatureCipher).get("s")).length,
      serverAbr: Boolean(streaming.serverAbrStreamingUrl),
      videoId: currentVideoId(response),
      title: response?.videoDetails?.title || "",
      owner: response?.videoDetails?.author || "",
      cover: thumbnails.at(-1)?.url || ""
    };
  };
  const androidPlayerResponse = async videoId => {
    const apiKey = window.ytcfg?.get?.("INNERTUBE_API_KEY") || window.ytcfg?.data_?.INNERTUBE_API_KEY || "";
    if (!videoId || !apiKey) return null;
    const response = await fetch(`/youtubei/v1/player?key=${encodeURIComponent(apiKey)}&prettyPrint=false`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName: "ANDROID",
            clientVersion: "20.10.38",
            androidSdkVersion: 35,
            hl: document.documentElement.lang || "zh-CN",
            gl: window.ytcfg?.get?.("GL") || window.ytcfg?.data_?.GL || "US"
          }
        },
        playbackContext: { contentPlaybackContext: { html5Preference: "HTML5_PREF_WANTS" } }
      })
    });
    if (!response.ok) throw new Error(`YouTube 播放信息请求失败：HTTP ${response.status}`);
    return response.json();
  };
  const collectFormats = async () => {
    const player = document.getElementById("movie_player");
    const pageResponse = player?.getPlayerResponse?.() || window.ytInitialPlayerResponse || null;
    let payload = summarize(pageResponse, "page");
    const shouldUseAndroid = Boolean(payload.videoId) && (!payload.formats.length || payload.encryptedCount > 0 || payload.serverAbr);
    if (shouldUseAndroid) {
      try {
        const androidResponse = await androidPlayerResponse(payload.videoId);
        if (androidResponse) {
          const androidPayload = summarize(androidResponse, "android");
          if (androidPayload.formats.length || androidPayload.status !== "UNKNOWN") payload = androidPayload;
        }
      } catch (error) {
        if (!payload.formats.length) payload.reason = error.message || payload.reason;
      }
    }
    return payload;
  };
  const emitFormats = async event => {
    let requestId = "";
    try { requestId = JSON.parse(String(event?.detail || "{}"))?.requestId || ""; } catch { /* Automatic player events have no request id. */ }
    if (!pending) pending = collectFormats().catch(() => null).finally(() => { pending = null; });
    const payload = await pending;
    if (payload) document.dispatchEvent(new CustomEvent("maru-youtube-formats", { detail: JSON.stringify({ ...payload, requestId }) }));
    return payload;
  };

  window.__maruYouTubeEmitFormats = emitFormats;
  document.addEventListener("maru-youtube-request", emitFormats);
  window.addEventListener("yt-navigate-finish", () => setTimeout(emitFormats, 300));
  window.addEventListener("yt-player-updated", () => setTimeout(emitFormats, 200));
  setTimeout(emitFormats, 900);
})();
