import { mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
const release = join(root, "release");
const assets = join(release, "store-assets");
const archive = join(release, `maru-media-sniffer-${manifest.version}.zip`);
await mkdir(assets, { recursive: true });

const runPowerShell = argumentsList => new Promise((resolve, reject) => {
  const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", ...argumentsList], { stdio: "inherit" });
  child.on("error", reject);
  child.on("close", code => code === 0 ? resolve() : reject(new Error(`PowerShell exited with ${code}`)));
});

await runPowerShell(["-File", join(root, "scripts", "generate-store-assets.ps1"), "-IconPath", join(root, "dist", "icons", "maru-128.png"), "-OutputDirectory", assets]);
await runPowerShell([
  "-File", join(root, "scripts", "package-release.ps1"),
  "-SourceDirectory", join(root, "dist"),
  "-DestinationPath", archive
]);
console.log(`Created ${archive}`);
