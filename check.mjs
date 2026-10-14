import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
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
const background = await readFile(join(root, "src/background/background.js"), "utf8");
if (!background.includes('importScripts("shared.js")')) throw new Error("Background worker must load shared media helpers");
console.log(`Checked ${files.length} JavaScript files and Manifest V3`);
