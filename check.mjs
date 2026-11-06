import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import vm from "node:vm";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const files = [
  "src/shared/shared.js",
  "src/content/content.js",
  "src/content/deep-search-main.js",
  "src/content/youtube-main.js",
  "src/background/background.js",
  "src/offscreen/offscreen.js",
  "src/popup/popup.js",
  "src/options/options.js",
  "scripts/generate-icons.mjs"
];
const checkNode = file => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["--check", join(root, file)], { stdio: "inherit" });
  child.on("close", code => code === 0 ? resolve() : reject(new Error(`Syntax check failed: ${file}`)));
});
for (const file of files) await checkNode(file);
const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
if (manifest.manifest_version !== 3 || manifest.background?.service_worker !== "background.js") throw new Error("Invalid Manifest V3 configuration");
assert.equal(manifest.version, "0.3.6");
const xDeepSearch = manifest.content_scripts?.find(script => script.world === "MAIN" && script.js?.includes("deep-search-main.js"));
if (!xDeepSearch || !xDeepSearch.all_frames || !xDeepSearch.matches?.some(pattern => pattern.includes("x.com"))) throw new Error("X main-world media observer is missing");
const background = await readFile(join(root, "src/background/background.js"), "utf8");
if (!background.includes('importScripts("shared.js")')) throw new Error("Background worker must load shared media helpers");
if (!background.includes("readPageMediaSnapshot") || !background.includes('world: "MAIN"')) throw new Error("Background must provide Edge-compatible page snapshot recovery");
if (!background.includes("replaceYouTubeFormats") || !background.includes("refreshYouTubeGroup") || !background.includes("onHistoryStateUpdated")) throw new Error("YouTube stale-address recovery is missing");
if (!background.includes("withTimeout") || !background.includes("fetchJsonWithTimeout")) throw new Error("Edge timeout recovery is missing");
if (!background.includes("webRequest.onBeforeRequest") || !background.includes("webRequest.onResponseStarted")) throw new Error("Dual-phase media request observation is missing");
if (!background.includes("pruneClosedTabState") || !background.includes("tabs.onReplaced")) throw new Error("Service-worker state recovery is missing");
const content = await readFile(join(root, "src/content/content.js"), "utf8");
if (!content.includes("CONTENT_PROTOCOL_VERSION = 9") || !content.includes("isTopFrame: window.top === window")) throw new Error("Content script protocol version or frame identity is missing");
if (!content.includes('type: "youtube-formats"') || !content.includes("youtubeRequests")) throw new Error("YouTube atomic refresh handshake is missing");
if (!content.includes("collectWeiboStatus") || !background.includes("/ajax/statuses/show?id=")) throw new Error("Weibo detail API recovery is missing");
const youtubeMain = await readFile(join(root, "src/content/youtube-main.js"), "utf8");
if (!youtubeMain.includes('clientName: "ANDROID"') || !youtubeMain.includes("androidPlayerResponse")) throw new Error("YouTube direct-format fallback is missing");
const shared = await readFile(join(root, "src/shared/shared.js"), "utf8");
const sandbox = { URL, TextEncoder };
vm.createContext(sandbox);
vm.runInContext(shared, sandbox);
assert.equal(sandbox.classifyMediaUrl("https://upos-hz-mirrorakam.akamaized.net/upgcxcode/1/2/sample-1-100023.m4s", { documentUrl: "https://www.bilibili.com/video/BV1HuigB9ExM/" }), "dash");
assert.equal(sandbox.classifyMediaUrl("https://cdn.example.com/upgcxcode/1/2/sample.m4s"), "segment");
assert.equal(sandbox.bilibiliStreamKindFromUrl("https://upos.example/upgcxcode/1/2/sample-1-30216.m4s"), "audio");
assert.equal(sandbox.bilibiliStreamKindFromUrl("https://upos.example/upgcxcode/1/2/sample-1-100023.m4s"), "video");
assert.equal(sandbox.isWeiboDetail("https://weibo.com/tv/show/1034%3A5294199457906810"), true);
assert.equal(sandbox.isWeiboDetail("https://weibo.com/video"), false);
assert.equal(sandbox.classifyMediaUrl("https://a.sinaimg.cn/mintra/pic/weibo_login.mp4", { documentUrl: "https://weibo.com/123/abc" }), null);
assert.equal(sandbox.isYouTube("https://www.youtube.com/watch?v=test"), true);
assert.equal(sandbox.youtubeVideoIdFromUrl("https://www.youtube.com/watch?v=abc123"), "abc123");
assert.equal(sandbox.youtubeVideoIdFromUrl("https://youtu.be/abc123?t=3"), "abc123");
assert.equal(sandbox.youtubeVideoIdFromUrl("https://www.youtube.com/shorts/abc123"), "abc123");
assert.equal(sandbox.classifyMediaUrl("https://www.youtube.com/watch?v=test", { type: "media", responseHeaders: [{ name: "content-type", value: "text/html; charset=utf-8" }] }), null);
assert.equal(
  sandbox.stableMediaFingerprint("https://cdn.example/video.m3u8?quality=1080&token=old&expires=1"),
  sandbox.stableMediaFingerprint("https://cdn.example/video.m3u8?expires=2&token=new&quality=1080")
);
assert.notEqual(
  sandbox.stableMediaFingerprint("https://cdn.example/video.m3u8?quality=1080&token=old"),
  sandbox.stableMediaFingerprint("https://cdn.example/video.m3u8?quality=720&token=old")
);
const deepSearch = await readFile(join(root, "src/content/deep-search-main.js"), "utf8");
const deepEvents = [];
const deepSandbox = {
  URL,
  location: { href: "https://x.com/example/status/123" },
  document: { dispatchEvent: event => deepEvents.push(event) },
  CustomEvent: class CustomEvent { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
  XMLHttpRequest: function XMLHttpRequest() {},
  queueMicrotask
};
deepSandbox.XMLHttpRequest.prototype.open = function open() {};
vm.createContext(deepSandbox);
vm.runInContext(deepSearch, deepSandbox);
vm.runInContext('JSON.parse("{\\"data\\":{\\"result\\":{\\"rest_id\\":\\"123\\",\\"media_url\\":\\"https://video.twimg.com/ext_tw_video/123/pu/pl/master.m3u8?tag=12\\"}},\\"suggestion\\":{\\"rest_id\\":\\"999\\",\\"media_url\\":\\"https://video.twimg.com/ext_tw_video/999/pu/pl/master.m3u8\\"}}")', deepSandbox);
await new Promise(resolve => setImmediate(resolve));
const deepItems = deepEvents.flatMap(event => JSON.parse(event.detail || "{}").items || []);
assert.equal(deepItems.some(item => item.url.includes("video.twimg.com") && item.url.includes(".m3u8")), true);
assert.equal(deepItems.some(item => item.url.includes("/999/")), false, JSON.stringify(deepItems));
console.log(`Checked ${files.length} JavaScript files and Manifest V3`);
