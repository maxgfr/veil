import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { auditHtml, type BuildResult, build, CSP, ORT_RUNTIME } from "./build";
import { BUDGET_GZIP, initialScripts } from "./check-size";

let out: BuildResult;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "veil-build-"));
  out = await build({ outdir: dir });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const read = (f: string) => readFileSync(join(dir, f), "utf8");

describe("build output", () => {
  test("the page carries the strict CSP, no-referrer and Trusted Types", () => {
    const html = read("index.html");
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
    expect(CSP).toContain("default-src 'none'");
    expect(CSP).toContain("require-trusted-types-for 'script'");
    // The only relaxation is WebAssembly compilation for the on-device model, and the
    // only remote hosts are where its weights and library are downloaded from.
    expect(CSP.split("; ")).toEqual([
      "default-src 'none'",
      "script-src 'self' 'wasm-unsafe-eval'",
      "style-src 'self'",
      "connect-src 'self' wss: https://huggingface.co https://*.hf.co https://raw.githubusercontent.com",
      "img-src 'self' blob: data:",
      "media-src 'self' blob:",
      "worker-src 'self'",
      "manifest-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "require-trusted-types-for 'script'",
    ]);
    expect(CSP.match(/'[^']*unsafe[^']*'/g)).toEqual(["'wasm-unsafe-eval'"]);
    expect(CSP.match(/https:\/\/[^\s;]+/g)).toEqual([
      "https://huggingface.co",
      "https://*.hf.co",
      "https://raw.githubusercontent.com",
    ]);
    expect(html).toContain('<meta name="referrer" content="no-referrer" />');
    // The CSP must come before anything it governs.
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<script"));
  });

  test("no inline script, handler or style; every reference is relative and exists", () => {
    const html = read("index.html");
    expect(() => auditHtml(html)).not.toThrow();
    const refs = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1] as string);
    expect(refs.length).toBeGreaterThan(3);
    for (const r of refs) {
      expect(r.startsWith("./")).toBe(true);
      expect(existsSync(join(dir, r))).toBe(true);
    }
  });

  test("no asset loads anything from another origin", () => {
    for (const f of out.files.filter((f) => /\.(js|css|html)$/.test(f))) {
      const src = read(f);
      expect(src).not.toMatch(/url\(\s*["']?(https?:)?\/\//);
      expect(src).not.toMatch(/\bimport\s*\(?\s*["']https?:/);
      expect(src).not.toMatch(/<script[^>]+src=["']https?:/);
    }
  });

  test("the service worker precaches exactly the build, under a content version", () => {
    const sw = read("sw.js");
    expect(sw).toContain(out.version);
    for (const f of out.files.filter((f) => f !== "sw.js")) expect(sw).toContain(`./${f}`);
  });

  test("the AI worker is cached on first use, not precached", () => {
    const sw = read("sw.js");
    expect(out.aiWorker).toMatch(/^assets\/ai-worker-[a-z0-9]+\.js$/);
    const precache = /\["\.\/"(?:,"[^"]+")*\]/.exec(sw)?.[0] ?? "";
    expect(precache).toContain('"./index.html"');
    expect(precache).not.toContain(out.aiWorker);
    expect(sw).toContain(`./${out.aiWorker}`);
    expect(sw).toContain("veil-ai-engine");
  });

  test("WebLLM is bundled into the AI worker and nowhere else", () => {
    // A string only WebLLM's runtime (TVM) carries.
    const marker = "tvmjs";
    expect(read(out.aiWorker)).toContain(marker);
    for (const f of out.files.filter((f) => f.endsWith(".js") && f !== out.aiWorker))
      expect(read(f)).not.toContain(marker);
  });

  test("the speech worker and ONNX Runtime's files are cached on first use, not precached", () => {
    const sw = read("sw.js");
    expect(out.speechWorker).toMatch(/^assets\/speech-worker-[a-z0-9]+\.js$/);
    expect(out.ortFiles.map((f) => f.replace(/-[0-9a-f]{8}\./, "."))).toEqual(
      ORT_RUNTIME.map((n) => `assets/${n}`),
    );
    const precache = /\["\.\/"(?:,"[^"]+")*\]/.exec(sw)?.[0] ?? "";
    for (const f of [out.speechWorker, ...out.ortFiles]) {
      expect(precache).not.toContain(f);
      expect(sw).toContain(`./${f}`);
    }
    expect(sw).toContain("veil-speech-engine");
    // The runtime is large: it is why it is not precached.
    const wasm = out.ortFiles.filter((f) => f.endsWith(".wasm"));
    expect(wasm.length).toBe(2);
    for (const f of wasm) expect(statSync(join(dir, f)).size).toBeGreaterThan(10e6);
  });

  test("transformers.js and ONNX Runtime are bundled into the speech worker and nowhere else", () => {
    // Strings only transformers.js's and ONNX Runtime's runtimes carry.
    const markers = [
      "Must implement _call method in subclass",
      "multiple calls to 'initializeWebAssembly()' detected.",
    ];
    const worker = read(out.speechWorker);
    for (const m of markers) expect(worker).toContain(m);
    for (const f of out.files.filter((f) => f.endsWith(".js") && f !== out.speechWorker))
      for (const m of markers) expect(read(f)).not.toContain(m);
  });

  test("no runtime code comes from a CDN: ONNX Runtime is served by this origin", () => {
    const cdn = /cdn\.jsdelivr\.net|unpkg\.com/g;
    for (const f of out.files.filter((f) => /\.(m?js|css|html)$/.test(f) && f !== out.speechWorker))
      expect(read(f)).not.toMatch(cdn);
    // transformers.js carries one CDN URL: the default it gives ONNX Runtime's
    // `wasmPaths` when it loads. The worker then sets `wasmPaths` to the files
    // copied next to it (their names are in it) and turns off transformers.js's
    // re-fetch of them, so that URL is never requested.
    const worker = read(out.speechWorker);
    expect(worker.match(cdn)).toEqual(["cdn.jsdelivr.net"]);
    expect(worker).toContain("cdn.jsdelivr.net/npm/onnxruntime-web@");
    for (const f of out.ortFiles) expect(worker).toContain(`"${f.slice("assets/".length)}"`);
    expect(worker).toMatch(/\.wasmPaths=\{mjs:/);
    expect(worker).toMatch(/\.useWasmCache=!1/);
  });

  test("the manifest is installable and its icons exist", () => {
    const m = JSON.parse(read("manifest.webmanifest")) as {
      display: string;
      start_url: string;
      icons: { src: string; purpose: string; sizes: string }[];
    };
    expect(m.display).toBe("standalone");
    expect(m.start_url).toBe("./");
    expect(m.icons.some((i) => i.purpose === "maskable")).toBe(true);
    expect(m.icons.some((i) => i.sizes === "512x512")).toBe(true);
    for (const i of m.icons) expect(existsSync(join(dir, i.src))).toBe(true);
  });

  test("the first screen fits the JS budget", () => {
    const total = initialScripts(dir).reduce((n, f) => n + gzipSync(readFileSync(f)).length, 0);
    expect(total).toBeLessThan(BUDGET_GZIP);
  });
});

describe("html audit", () => {
  test("rejects inline scripts, handlers, styles and external or absolute URLs", () => {
    expect(() => auditHtml("<script>alert(1)</script>")).toThrow(/inline <script>/);
    expect(() => auditHtml('<script src="./a.js">x</script>')).toThrow(/inline <script>/);
    expect(() => auditHtml('<img src="./a.png" onerror="x()">')).toThrow(/event handler/);
    expect(() => auditHtml("<style>body{}</style>")).toThrow(/inline <style>/);
    expect(() => auditHtml('<script src="https://cdn.example/a.js"></script>')).toThrow(
      /external URL/,
    );
    expect(() => auditHtml('<link href="//cdn.example/a.css">')).toThrow(/external URL/);
    expect(() => auditHtml('<script src="/assets/a.js"></script>')).toThrow(/absolute path/);
    expect(() => auditHtml('<script type="module" src="./a.js"></script>')).not.toThrow();
  });
});
