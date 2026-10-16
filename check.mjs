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
assert.equal(manifest.version, "0.2.9");
const background = await readFile(join(root, "src/background/background.js"), "utf8");
if (!background.includes('importScripts("shared.js")')) throw new Error("Background worker must load shared media helpers");
if (!background.includes("readPageMediaSnapshot") || !background.includes('world: "MAIN"')) throw new Error("Background must provide Edge-compatible page snapshot recovery");
const content = await readFile(join(root, "src/content/content.js"), "utf8");
if (!content.includes("CONTENT_PROTOCOL_VERSION = 2")) throw new Error("Content script protocol version is missing");
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
console.log(`Checked ${files.length} JavaScript files and Manifest V3`);
