// Usage: npm run updater:endpoint -- <owner/repo>
// Rewrites src-tauri/tauri.conf.json plugins.updater.endpoints to the stable
// GitHub Releases latest.json URL. Keeps the signed pubkey untouched.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const confPath = resolve(here, "../src-tauri/tauri.conf.json");

const repo = process.argv[2];
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
  console.error("Usage: npm run updater:endpoint -- <owner/repo>");
  process.exit(1);
}

const raw = readFileSync(confPath, "utf-8");
const conf = JSON.parse(raw);
conf.plugins ??= {};
conf.plugins.updater ??= { active: true };
conf.plugins.updater.endpoints = [
  `https://github.com/${repo}/releases/latest/download/latest.json`,
];
conf.plugins.updater.dialog = true;
conf.plugins.updater.windows ??= {};
conf.plugins.updater.windows.stableOnly = true;
writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n");
console.log(`updater endpoint → ${conf.plugins.updater.endpoints[0]}`);
