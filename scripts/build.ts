/**
 * Production build: Bun.build on the HTML entrypoint, hashed assets, relative
 * paths (the site lives under /veil/), CSP + security metas injected into the
 * page, and a generated service worker that precaches every hashed asset.
 *
 * The build fails if the resulting page contains an inline script or a
 * reference to an external origin.
 */
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

export const CSP = [
  "default-src 'none'",
  // RNNoise (opt-in strong noise reduction) compiles WebAssembly; no eval of JavaScript.
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "connect-src 'self' wss:",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "worker-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "require-trusted-types-for 'script'",
].join("; ");

const HEAD_INJECT = [
  `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
  `<meta name="referrer" content="no-referrer" />`,
  `<meta name="color-scheme" content="light dark" />`,
  `<meta name="theme-color" content="#f6f5f1" media="(prefers-color-scheme: light)" />`,
  `<meta name="theme-color" content="#121316" media="(prefers-color-scheme: dark)" />`,
  `<meta name="description" content="Serverless, end-to-end encrypted rooms for chat, files and calls. Peer-to-peer, no account." />`,
  `<meta name="apple-mobile-web-app-capable" content="yes" />`,
  `<meta name="mobile-web-app-capable" content="yes" />`,
  `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />`,
  `<link rel="manifest" href="./manifest.webmanifest" />`,
  `<link rel="icon" href="./icons/icon.svg" type="image/svg+xml" />`,
  `<link rel="apple-touch-icon" href="./icons/apple-touch-icon.png" />`,
].join("\n    ");

export interface BuildOptions {
  outdir?: string;
  minify?: boolean;
}

export interface BuildResult {
  outdir: string;
  version: string;
  files: string[];
}

function fail(msg: string): never {
  throw new Error(`build: ${msg}`);
}

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(p, base)));
    else out.push(relative(base, p).split("\\").join("/"));
  }
  return out.sort();
}

/** The opt-in noise reduction's files: downloaded only when it is turned on, so never precached. */
export const LAZY_DIR = "assets/noise";

const NOISE_FILES = {
  worklet: "rnnoise/workletProcessor.js",
  wasm: "rnnoise.wasm",
  simd: "rnnoise_simd.wasm",
} as const;

type NoiseAssets = Record<keyof typeof NOISE_FILES, string>;

/** Copies RNNoise's worklet and binaries under content-hashed names; returns their URLs. */
async function copyNoiseAssets(outdir: string): Promise<NoiseAssets> {
  const src = join(ROOT, "node_modules/@sapphi-red/web-noise-suppressor/dist");
  await mkdir(join(outdir, LAZY_DIR), { recursive: true });
  const urls = {} as NoiseAssets;
  for (const [key, file] of Object.entries(NOISE_FILES) as [keyof NoiseAssets, string][]) {
    const data = await readFile(join(src, file));
    const hash = createHash("sha256").update(data).digest("hex").slice(0, 8);
    const name = (file.split("/").pop() ?? file).replace(/\.(js|wasm)$/, `-${hash}.$1`);
    await writeFile(join(outdir, LAZY_DIR, name), data);
    urls[key] = `./${LAZY_DIR}/${name}`;
  }
  return urls;
}

function assertOk(result: Awaited<ReturnType<typeof Bun.build>>, what: string): void {
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    fail(`${what} failed`);
  }
}

/** Throws if the HTML has an inline script, inline handler or external URL. */
export function auditHtml(html: string): void {
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1] ?? "";
    const body = (m[2] ?? "").trim();
    if (!/\bsrc\s*=/.test(attrs) || body.length > 0) fail("inline <script> found in index.html");
  }
  if (/\son[a-z]+\s*=/i.test(html)) fail("inline event handler found in index.html");
  if (/<style\b/i.test(html)) fail("inline <style> found in index.html");
  for (const m of html.matchAll(/\b(?:src|href)\s*=\s*"([^"]*)"/gi)) {
    const url = m[1] ?? "";
    if (/^(?:[a-z]+:)?\/\//i.test(url)) fail(`external URL in index.html: ${url}`);
    if (url.startsWith("/")) fail(`absolute path in index.html (breaks the /veil/ base): ${url}`);
  }
}

export async function build(opts: BuildOptions = {}): Promise<BuildResult> {
  const outdir = resolve(ROOT, opts.outdir ?? "dist");
  const minify = opts.minify ?? true;
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });

  const naming = {
    entry: "[name].[ext]",
    chunk: "assets/[name]-[hash].[ext]",
    asset: "assets/[name]-[hash].[ext]",
  };

  // 1. The E2EE worker is a separate hashed entrypoint; its URL is injected into the app.
  const worker = await Bun.build({
    entrypoints: [join(ROOT, "src/workers/e2ee-worker.ts")],
    outdir,
    minify,
    target: "browser",
    format: "esm",
    naming: { entry: "assets/[name]-[hash].[ext]" },
  });
  assertOk(worker, "worker build");
  const workerOut =
    worker.outputs.find((o) => o.kind === "entry-point") ?? fail("no worker output");
  const workerUrl = `./${relative(outdir, workerOut.path).split("\\").join("/")}`;

  const noiseAssets = await copyNoiseAssets(outdir);

  // 2. The app, from its HTML entrypoint.
  const app = await Bun.build({
    entrypoints: [join(ROOT, "index.html")],
    outdir,
    minify,
    splitting: true,
    target: "browser",
    format: "esm",
    naming,
    define: {
      __E2EE_WORKER_URL__: JSON.stringify(workerUrl),
      __NOISE_ASSETS__: JSON.stringify(noiseAssets),
      "process.env.NODE_ENV": JSON.stringify(minify ? "production" : "development"),
    },
  });
  assertOk(app, "app build");

  // 3. Static files (manifest, icons).
  await cp(join(ROOT, "public"), outdir, { recursive: true });

  // 4. Harden the page.
  const htmlPath = join(outdir, "index.html");
  let html = await readFile(htmlPath, "utf8");
  if (!/<meta charset="utf-8"\s*\/?>/i.test(html))
    fail("index.html must start with <meta charset>");
  html = html.replace(/(<meta charset="utf-8"\s*\/?>)/i, `$1\n    ${HEAD_INJECT}`);
  auditHtml(html);
  await writeFile(htmlPath, html);

  // 5. Service worker, versioned by the content hash of everything it caches.
  const files = (await listFiles(outdir)).filter(
    (f) => f !== "sw.js" && !f.startsWith(`${LAZY_DIR}/`),
  );
  const hash = createHash("sha256");
  for (const f of files) {
    hash.update(f);
    hash.update(await readFile(join(outdir, f)));
  }
  const version = hash.digest("hex").slice(0, 16);
  const sw = await Bun.build({
    entrypoints: [join(ROOT, "src/sw.ts")],
    outdir,
    minify,
    target: "browser",
    format: "esm",
    naming: { entry: "sw.js" },
    define: {
      __SW_VERSION__: JSON.stringify(version),
      __PRECACHE__: JSON.stringify(["./", ...files.map((f) => `./${f}`)]),
    },
  });
  assertOk(sw, "service worker build");

  return {
    outdir,
    version,
    files: [...files, "sw.js"],
  };
}

if (import.meta.main) {
  const started = performance.now();
  const dev = process.argv.includes("--dev");
  const res = await build({ minify: !dev });
  let bytes = 0;
  for (const f of res.files) bytes += (await stat(join(res.outdir, f))).size;
  console.log(
    `built ${res.files.length} files (${(bytes / 1024).toFixed(1)} KiB) v${res.version} in ${Math.round(performance.now() - started)} ms`,
  );
}
