import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { auditHtml, type BuildResult, build, CSP, LAZY_DIR } from "./build";
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
    // No relaxation and no remote host: nothing is downloaded from elsewhere.
    expect(CSP.split("; ")).toEqual([
      "default-src 'none'",
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
    ]);
    // The one relaxation: compiling WebAssembly (opt-in noise reduction), never JavaScript.
    expect(CSP.replace("'wasm-unsafe-eval'", "")).not.toContain("unsafe");
    expect(CSP).not.toContain("https:");
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
    // Fetched past the HTTP cache, so a stale shell never names a script the deploy removed.
    expect(sw).toMatch(/cache:\s*"reload"/);
  });

  test("the noise reduction's files are built, and downloaded only when it is turned on", () => {
    const noise = readdirSync(join(dir, LAZY_DIR)).sort();
    expect(noise).toHaveLength(3);
    expect(noise.some((f) => /^workletProcessor-\w+\.js$/.test(f))).toBe(true);
    expect(noise.filter((f) => f.endsWith(".wasm"))).toHaveLength(2);
    const sw = read("sw.js");
    for (const f of noise) {
      expect(sw).not.toContain(f);
      expect(out.files).not.toContain(`${LAZY_DIR}/${f}`);
    }
  });

  test("no runtime code comes from a CDN", () => {
    for (const f of out.files.filter((f) => /\.(m?js|css|html)$/.test(f)))
      expect(read(f)).not.toMatch(/cdn\.jsdelivr\.net|unpkg\.com/);
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
