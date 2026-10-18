import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const host = process.env.TAURI_DEV_HOST;

function tokscaleRealDataBridge(): Plugin {
  const cache = new Map<string, { at: number; body: string }>();
  let lastScanAt: string | null = new Date().toISOString();

  const binPath = path.resolve(
    __dirname,
    "src-tauri",
    "target",
    "debug",
    "examples",
    process.platform === "win32" ? "dump_snapshot.exe" : "dump_snapshot",
  );

  function runDump(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!existsSync(binPath)) {
        reject(new Error(`Real snapshot binary not found at ${binPath}`));
        return;
      }
      execFile(binPath, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || err.message));
          return;
        }
        resolve(stdout);
      });
    });
  }

  return {
    name: "tokscale-real-data-bridge",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/__tokentracker/")) {
          next();
          return;
        }
        const url = new URL(req.url, "http://localhost:1420");
        res.setHeader("Content-Type", "application/json");

        if (url.pathname === "/__tokentracker/live-status") {
          res.end(
            JSON.stringify({
              watching: true,
              last_scan_at: lastScanAt,
              pending_files: 0,
              errors: [],
            }),
          );
          return;
        }

        if (url.pathname === "/__tokentracker/rescan") {
          const t0 = Date.now();
          cache.clear();
          try {
            const json = await runDump([]);
            cache.set("||", { at: Date.now(), body: json });
            lastScanAt = new Date().toISOString();
            const parsed = JSON.parse(json);
            const count = parsed.sessions?.length ?? 0;
            res.end(
              JSON.stringify({
                scanned_files: count,
                new_records: count,
                took_ms: Date.now() - t0,
              }),
            );
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: String(e) }));
          }
          return;
        }

        if (url.pathname === "/__tokentracker/snapshot") {
          const clients = url.searchParams.get("clients") || "";
          const since = url.searchParams.get("since") || "";
          const until = url.searchParams.get("until") || "";
          const key = `${clients}|${since}|${until}`;
          const cached = cache.get(key);
          if (cached && Date.now() - cached.at < 30_000) {
            res.end(cached.body);
            return;
          }
          const args: string[] = [];
          if (clients) args.push("--clients", clients);
          if (since) args.push("--since", since);
          if (until) args.push("--until", until);
          try {
            const json = await runDump(args);
            cache.set(key, { at: Date.now(), body: json });
            lastScanAt = new Date().toISOString();
            res.end(json);
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: String(e) }));
          }
          return;
        }

        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), tokscaleRealDataBridge()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
