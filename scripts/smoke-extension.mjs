import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createNetServer } from "node:net";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const extensionPath = join(root, "dist");
const chromePath = process.env.MARU_CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const externalUrl = process.env.MARU_SMOKE_URL || "";
const expectedType = process.env.MARU_EXPECTED_TYPE || "direct";
const expectedPageStatus = process.env.MARU_EXPECTED_PAGE_STATUS || "";
const fixture = process.env.MARU_FIXTURE || "";
const profilePath = await mkdtemp(join(tmpdir(), "maru-smoke-"));
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function terminateProcessTree(processId) {
  if (!processId) return;
  const killer = spawn("taskkill.exe", ["/PID", String(processId), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  await new Promise(resolve => killer.once("close", resolve));
}

async function availablePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function json(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function waitForTargets(port) {
  const deadline = Date.now() + 15_000;
  let lastTargets = [];
  while (Date.now() < deadline) {
    try {
      const targets = await json(`http://127.0.0.1:${port}/json/list`);
      lastTargets = targets.map(target => ({ type: target.type, url: target.url }));
      const workers = targets.filter(target => target.type === "service_worker" && target.url.endsWith("/background.js"));
      if (workers.length === 1) return workers[0];
      for (const worker of workers) {
        try {
          const name = await evaluate(worker.webSocketDebuggerUrl, "chrome.runtime?.getManifest?.().name || ''");
          if (name === "丸酱媒体嗅探助手") return worker;
        } catch { /* Ignore unrelated service workers. */ }
      }
    } catch { /* Chrome is still starting. */ }
    await delay(200);
  }
  throw new Error(`Extension service worker did not start; targets=${JSON.stringify(lastTargets)}`);
}

async function evaluate(webSocketDebuggerUrl, expression) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const id = 1;
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP evaluation timed out")), 15000);
    socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  socket.close();
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "CDP evaluation failed");
  return result.result?.value;
}

async function sendCdp(webSocketDebuggerUrl, method, params = {}) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const id = 1;
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP ${method} timed out`)), 15000);
    socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
  socket.close();
  return result;
}

async function createTarget(port, url) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!response.ok) throw new Error(`Cannot create extension test target: ${response.status}`);
  return response.json();
}

const media = Buffer.alloc(4096, 1);
let mediaRequestCount = 0;
let web;
let targetUrl = externalUrl;
if (!targetUrl) {
  web = createServer((request, response) => {
    if (request.url?.startsWith("/sample.mp4")) {
      mediaRequestCount += 1;
      response.writeHead(200, { "content-type": "video/mp4", "content-length": media.length, "accept-ranges": "bytes" });
      response.end(media);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (fixture === "bilibili") {
      response.end(`<!doctype html><title>B站主世界恢复测试</title><script>
        window.__INITIAL_STATE__ = { videoData: { bvid: "BV1fixture01", title: "B站恢复测试视频", pic: "", owner: { name: "丸酱测试" }, pages: [{ page: 1, part: "第一集" }] } };
        window.__playinfo__ = { data: { dash: { video: [{ baseUrl: "http://127.0.0.1:${web.address().port}/fixture-video.m4s", width: 1920, height: 1080, mimeType: "video/mp4" }], audio: [{ baseUrl: "http://127.0.0.1:${web.address().port}/fixture-audio.m4s", mimeType: "audio/mp4" }] } } };
      </script>`);
    } else {
      response.end("<!doctype html><title>丸酱烟雾测试</title><video autoplay muted preload='auto' controls src='/sample.mp4'></video><script>fetch('/sample.mp4?probe=1').catch(() => {})</script>");
    }
  });
  await new Promise((resolve, reject) => web.once("error", reject).listen(0, "127.0.0.1", resolve));
  targetUrl = `http://127.0.0.1:${web.address().port}/`;
}
const debugPort = await availablePort();
const chrome = spawn(chromePath, [
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--window-position=-32000,-32000",
  "--window-size=800,600",
  `--user-data-dir=${profilePath}`,
  `--disable-extensions-except=${extensionPath}`,
  `--load-extension=${extensionPath}`,
  `--remote-debugging-port=${debugPort}`,
  "--autoplay-policy=no-user-gesture-required",
  targetUrl
], { stdio: "ignore", windowsHide: true });

try {
  const worker = await waitForTargets(debugPort);
  let popupTarget = null;
  let mediaTarget = null;
  if (externalUrl || fixture) {
    popupTarget = await createTarget(debugPort, `chrome-extension://${new URL(worker.url).hostname}/popup.html`);
    const targets = await json(`http://127.0.0.1:${debugPort}/json/list`);
    mediaTarget = targets.find(target => target.type === "page" && target.url === targetUrl)
      || targets.find(target => target.type === "page" && target.url.startsWith(targetUrl))
      || targets.find(target => target.type === "page" && !target.url.startsWith("chrome-extension://") && !target.url.startsWith("chrome://"));
    if (!mediaTarget) throw new Error(`Media test target not found for ${targetUrl}`);
    await sendCdp(mediaTarget.webSocketDebuggerUrl, "Page.bringToFront");
  }
  const storageTarget = popupTarget || worker;
  let state;
  let scanResult = "";
  const deadline = Date.now() + (externalUrl ? 25_000 : 10_000);
  while (Date.now() < deadline) {
    if (externalUrl || fixture) {
      if (!scanResult) console.log("Smoke: requesting current tab state through the extension popup");
      scanResult = await evaluate(popupTarget.webSocketDebuggerUrl, "chrome.runtime.sendMessage({ type: 'get-current' }).then(value => JSON.stringify(value)).catch(error => JSON.stringify({ error: error?.message || String(error) }))");
    }
    if (!state) console.log("Smoke: reading extension session state");
    const serialized = await evaluate(storageTarget.webSocketDebuggerUrl, "chrome.storage.session.get(null).then(value => JSON.stringify(value))");
    state = JSON.parse(serialized || "{}");
    if (expectedPageStatus && Object.values(state || {}).some(value => value?.page?.youtubeStatus === expectedPageStatus)) break;
    if (Object.values(state || {}).some(value => value?.groups?.some(group => group.type === expectedType))) break;
    await delay(250);
  }
  const groups = Object.values(state || {}).flatMap(value => value?.groups || []);
  if (expectedPageStatus) {
    const pageState = Object.values(state || {}).find(value => value?.page?.youtubeStatus === expectedPageStatus);
    if (!pageState) throw new Error(`No page status ${expectedPageStatus} detected: ${JSON.stringify(state)}; scan=${scanResult}`);
    if (groups.length) throw new Error(`Unavailable page exposed false media groups: ${JSON.stringify(groups)}`);
    console.log(`Smoke test passed: detected page status ${expectedPageStatus} with no false media groups`);
  } else {
    const matched = groups.find(group => group.type === expectedType);
    if (!matched) throw new Error(`No ${expectedType} media detected after ${mediaRequestCount} local request(s): ${JSON.stringify(state)}; scan=${scanResult}`);
    if (matched.isYouTube) {
      const probeUrl = matched.completeUrl || matched.videoUrl || matched.audioUrl;
      if (!probeUrl) throw new Error(`YouTube group has no downloadable candidate: ${JSON.stringify(matched)}`);
      const probeResult = JSON.parse(await evaluate(popupTarget.webSocketDebuggerUrl, `fetch(${JSON.stringify(probeUrl)}, { headers: { Range: "bytes=0-1023" } }).then(async response => { const result = { ok: response.ok, status: response.status, mime: response.headers.get("content-type") || "" }; await response.body?.cancel(); return JSON.stringify(result); }).catch(error => JSON.stringify({ ok: false, status: 0, mime: "", error: error?.message || String(error) }))`));
      if (!probeResult.ok || !/^(?:video|audio)\//i.test(probeResult.mime)) throw new Error(`YouTube candidate probe failed: HTTP ${probeResult.status}, ${probeResult.mime || probeResult.error || "unknown content type"}`);
      if (!/msedge\.exe$/i.test(chromePath)) {
        const backgroundProbe = JSON.parse(await evaluate(worker.webSocketDebuggerUrl, `firstUsableMediaUrl([${JSON.stringify(probeUrl)}], "YouTube smoke stream", ${JSON.stringify(matched.sourceUrl || externalUrl)}).then(url => JSON.stringify({ ok: true, url })).catch(error => JSON.stringify({ ok: false, error: error?.message || String(error) }))`));
        if (!backgroundProbe.ok || !/^https?:/i.test(backgroundProbe.url || "")) throw new Error(`YouTube background download preflight failed: ${backgroundProbe.error || "no usable URL"}`);
      }
      const originalCount = matched.count || 0;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await evaluate(popupTarget.webSocketDebuggerUrl, "chrome.runtime.sendMessage({ type: 'get-current' }).then(value => JSON.stringify(value))");
      }
      const refreshedSerialized = await evaluate(storageTarget.webSocketDebuggerUrl, "chrome.storage.session.get(null).then(value => JSON.stringify(value))");
      const refreshedGroups = Object.values(JSON.parse(refreshedSerialized || "{}")).flatMap(value => value?.groups || []).filter(group => group.isYouTube);
      if (refreshedGroups.length !== 1 || refreshedGroups[0].count !== originalCount) throw new Error(`YouTube repeated scans accumulated stale candidates: before=${originalCount}, after=${JSON.stringify(refreshedGroups)}`);
      const resetVideoId = "maruStateReset01";
      await evaluate(mediaTarget.webSocketDebuggerUrl, `history.pushState({}, "", "/watch?v=${resetVideoId}"); window.dispatchEvent(new Event("yt-navigate-finish")); location.href`);
      await delay(700);
      const resetSerialized = await evaluate(storageTarget.webSocketDebuggerUrl, "chrome.storage.session.get(null).then(value => JSON.stringify(value))");
      const resetStates = Object.values(JSON.parse(resetSerialized || "{}"));
      const resetState = resetStates.find(value => value?.page?.youtubeVideoId === "maruStateReset01");
      if (!resetState || resetState.groups?.some(group => group.isYouTube)) throw new Error(`YouTube SPA navigation retained the previous video's candidates: ${JSON.stringify(resetStates)}`);
    }
    const details = matched.isYouTube
      ? `, YouTube ${matched.isYouTubeComplete ? "complete" : "split"}, ${matched.count || 0} candidate(s), quality ${matched.qualityLabel || "unknown"}`
      : matched.variants?.length ? `, ${matched.variants.length} variant(s), quality ${matched.qualityLabel || "unknown"}` : "";
    console.log(`Smoke test passed: detected ${groups.length} media group(s), including ${expectedType}${details}`);
  }
} finally {
  await terminateProcessTree(chrome.pid);
  if (web) await new Promise(resolve => web.close(resolve));
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { await rm(profilePath, { recursive: true, force: true }); break; }
    catch (error) { if (attempt === 4) throw error; await delay(200); }
  }
}
