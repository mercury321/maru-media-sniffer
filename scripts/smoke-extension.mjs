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

const media = Buffer.alloc(4096, 1);
let mediaRequestCount = 0;
const web = createServer((request, response) => {
  if (request.url?.startsWith("/sample.mp4")) {
    mediaRequestCount += 1;
    response.writeHead(200, { "content-type": "video/mp4", "content-length": media.length, "accept-ranges": "bytes" });
    response.end(media);
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end("<!doctype html><title>丸酱烟雾测试</title><video autoplay muted preload='auto' controls src='/sample.mp4'></video><script>fetch('/sample.mp4?probe=1').catch(() => {})</script>");
});

await new Promise((resolve, reject) => web.once("error", reject).listen(0, "127.0.0.1", resolve));
const webPort = web.address().port;
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
  `http://127.0.0.1:${webPort}/`
], { stdio: "ignore", windowsHide: true });

try {
  const worker = await waitForTargets(debugPort);
  let state;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const serialized = await evaluate(worker.webSocketDebuggerUrl, "chrome.storage.session.get(null).then(value => JSON.stringify(value))");
    state = JSON.parse(serialized || "{}");
    if (Object.values(state || {}).some(value => value?.groups?.some(group => group.type === 'direct'))) break;
    await delay(250);
  }
  const groups = Object.values(state || {}).flatMap(value => value?.groups || []);
  if (!groups.some(group => group.type === "direct")) throw new Error(`No direct media detected after ${mediaRequestCount} request(s): ${JSON.stringify(state)}`);
  console.log(`Smoke test passed: detected ${groups.length} media group(s)`);
} finally {
  await terminateProcessTree(chrome.pid);
  await new Promise(resolve => web.close(resolve));
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { await rm(profilePath, { recursive: true, force: true }); break; }
    catch (error) { if (attempt === 4) throw error; await delay(200); }
  }
}
