(() => {
  const emitFormats = () => {
    try {
      const player = document.getElementById("movie_player");
      const response = player?.getPlayerResponse?.() || window.ytInitialPlayerResponse;
      const streaming = response?.streamingData;
      if (!streaming) return;
      const formats = [...(streaming.formats || []), ...(streaming.adaptiveFormats || [])].map(format => {
        let url = format.url || "";
        if (!url && format.signatureCipher) {
          const cipher = new URLSearchParams(format.signatureCipher);
          if (!cipher.get("s")) {
            url = cipher.get("url") || "";
            const signature = cipher.get("sig") || cipher.get("signature");
            if (url && signature) {
              const signed = new URL(url);
              signed.searchParams.set(cipher.get("sp") || "signature", signature);
              url = signed.toString();
            }
          }
        }
        const mimeType = format.mimeType || "";
        const hasVideo = mimeType.startsWith("video/");
        const hasAudio = mimeType.startsWith("audio/") || Boolean(format.audioQuality);
        return {
          url,
          mimeType,
          itag: format.itag,
          bitrate: format.bitrate,
          contentLength: format.contentLength,
          width: format.width,
          height: format.height,
          qualityLabel: format.qualityLabel,
          hasVideo,
          hasAudio,
          isProgressive: hasVideo && hasAudio
        };
      }).filter(format => /^https?:/i.test(format.url));
      if (formats.length) document.dispatchEvent(new CustomEvent("maru-youtube-formats", { detail: JSON.stringify({ formats }) }));
    } catch { /* Player data is transient while YouTube navigates. */ }
  };

  document.addEventListener("maru-youtube-request", emitFormats);
  window.addEventListener("yt-navigate-finish", () => setTimeout(emitFormats, 300));
  window.addEventListener("yt-player-updated", () => setTimeout(emitFormats, 200));
  setTimeout(emitFormats, 900);
})();
