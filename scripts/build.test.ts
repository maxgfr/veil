import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { auditHtml, type BuildResult, build, CSP } from "./build";
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
    expect(CSP).toContain("script-src 'self'");
    expect(CSP).toContain("require-trusted-types-for 'script'");
    expect(CSP).not.toContain("unsafe");
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
