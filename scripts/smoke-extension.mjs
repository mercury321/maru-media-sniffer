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
  while (Date.now() < deadline) {
    try {
      const targets = await json(`http://127.0.0.1:${port}/json/list`);
      const workers = targets.filter(target => target.type === "service_worker" && target.url.endsWith("/background.js"));
      for (const worker of workers) {
        try {
          const name = await evaluate(worker.webSocketDebuggerUrl, "chrome.runtime?.getManifest?.().name || ''");
          if (name === "丸酱媒体嗅探助手") return worker;
        } catch { /* Ignore unrelated service workers. */ }
      }
    } catch { /* Chrome is still starting. */ }
    await delay(200);
  }
  throw new Error("Extension service worker did not start");
}

async function evaluate(webSocketDebuggerUrl, expression) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const id = 1;
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP evaluation timed out")), 5000);
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
    const timer = setTimeout(() => reject(new Error(`CDP ${method} timed out`)), 5000);
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
    mediaTarget = targets.find(target => target.type === "page" && target.url === targetUrl) || targets.find(target => target.type === "page" && target.url.startsWith(targetUrl));
    if (!mediaTarget) throw new Error(`Media test target not found for ${targetUrl}`);
    await sendCdp(mediaTarget.webSocketDebuggerUrl, "Page.bringToFront");
  }
  let state;
  let scanResult = "";
  const deadline = Date.now() + (externalUrl ? 25_000 : 10_000);
  while (Date.now() < deadline) {
    if (externalUrl || fixture) {
      scanResult = await evaluate(popupTarget.webSocketDebuggerUrl, "chrome.runtime.sendMessage({ type: 'get-current' }).then(value => JSON.stringify(value)).catch(error => JSON.stringify({ error: error?.message || String(error) }))");
    }
    const serialized = await evaluate(worker.webSocketDebuggerUrl, "chrome.storage.session.get(null).then(value => JSON.stringify(value))");
    state = JSON.parse(serialized || "{}");
    if (Object.values(state || {}).some(value => value?.groups?.some(group => group.type === expectedType))) break;
    await delay(250);
  }
  const groups = Object.values(state || {}).flatMap(value => value?.groups || []);
  const matched = groups.find(group => group.type === expectedType);
  if (!matched) throw new Error(`No ${expectedType} media detected after ${mediaRequestCount} local request(s): ${JSON.stringify(state)}; scan=${scanResult}`);
  const details = matched.variants?.length ? `, ${matched.variants.length} variant(s), quality ${matched.qualityLabel || "unknown"}` : "";
  console.log(`Smoke test passed: detected ${groups.length} media group(s), including ${expectedType}${details}`);
} finally {
  await terminateProcessTree(chrome.pid);
  if (web) await new Promise(resolve => web.close(resolve));
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { await rm(profilePath, { recursive: true, force: true }); break; }
    catch (error) { if (attempt === 4) throw error; await delay(200); }
  }
}
