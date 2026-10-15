import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { closeSheets, createRoom, joinRoom, member, openChat, say, waitMembers } from "./helpers";

const BIN = resolve(process.cwd(), "cli/target", process.env.VEIL_CLI_PROFILE ?? "debug", "veil");
const NET = [
  "--relay",
  "ws://localhost:4173/relay",
  "--no-torrent",
  "--no-stun",
  "--base",
  "http://localhost:4173/?nosw",
];

// Chromium hides host IPs behind mDNS names; CI runners do not route multicast DNS, so the CLI
// could not resolve them. Real networks also offer STUN candidates; here we expose host IPs instead.
test.use({ launchOptions: { args: ["--disable-features=WebRtcHideLocalIpsWithMdns"] } });

test.skip(
  !existsSync(BIN),
  `build the CLI first (cargo build --manifest-path cli/Cargo.toml): ${BIN}`,
);

interface Proc {
  child: ChildProcess;
  stdout: string[];
  stderr: string[];
  exited: Promise<number | null>;
  write(line: string): void;
}

function run(args: string[]): Proc {
  const child = spawn(BIN, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, VEIL_DEBUG: "1" },
  });
  child.stderr?.on(
    "data",
    (d: Buffer) => process.env.VEIL_E2E_VERBOSE && process.stderr.write(`[cli] ${d}`),
  );
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout?.on("data", (d: Buffer) => stdout.push(...d.toString().split("\n").filter(Boolean)));
  child.stderr?.on("data", (d: Buffer) => stderr.push(...d.toString().split("\n").filter(Boolean)));
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  return { child, stdout, stderr, exited, write: (l) => child.stdin?.write(`${l}\n`) };
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

test("the CLI sends a file to a browser", async ({ browser }) => {
  const dir = mkdtempSync(join(tmpdir(), "veil-cli-"));
  const src = join(dir, "from-cli.bin");
  const data = Buffer.from(
    Array.from({ length: 3 * 1024 * 1024 + 17 }, (_, i) => (i * 31 + 7) & 255),
  );
  writeFileSync(src, data);
  const cli = run(["send", src, "--once", "--nick", "Terminal", ...NET]);
  await expect.poll(() => cli.stdout[0] ?? "", { timeout: 15_000 }).toContain("#");
  const link = cli.stdout[0] as string;

  const b = await member(browser);
  await b.ctx.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  // `veil send` shares a files room: the browser opens the Files view, no camera or microphone.
  expect(link).toContain("#files/");
  await joinRoom(b, link, "Browser");
  await expect(b.page.getByTestId("room")).toHaveAttribute("data-mode", "files");
  await expect(b.page.getByTestId("toggle-mic")).toHaveCount(0);
  await closeSheets(b.page);
  await waitMembers(b.page, 1, 30_000);
  const panel = b.page.getByTestId("files-panel");
  await expect(panel.getByText("From Terminal")).toBeVisible({ timeout: 30_000 });
  await panel.getByTestId("file-accept").click();
  await expect(panel.locator("[data-testid=file-card][data-state=done]")).toBeVisible({
    timeout: 60_000,
  });
  const download = b.page.waitForEvent("download");
  await panel.getByTestId("file-save").click();
  const saved = join(dir, "received.bin");
  await (await download).saveAs(saved);
  expect(sha(readFileSync(saved))).toBe(sha(data));
  expect(await cli.exited).toBe(0);
  expect(cli.stderr.join("\n")).toContain("delivered to Browser");
  await b.ctx.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a browser sends a file to the CLI", async ({ browser }) => {
  const dir = mkdtempSync(join(tmpdir(), "veil-cli-"));
  const a = await member(browser);
  const link = await createRoom(a, "Browser");
  const cli = run(["receive", link, "--yes", "--once", "--out", dir, "--nick", "Terminal", ...NET]);
  await waitMembers(a.page, 1, 30_000);
  const data = Buffer.from(Array.from({ length: 2 * 1024 * 1024 + 5 }, (_, i) => (i * 13) & 255));
  await openChat(a.page);
  await a.page.getByTestId("file-input").setInputFiles({
    name: "../../evil name.bin",
    mimeType: "application/octet-stream",
    buffer: data,
  });
  expect(await cli.exited).toBe(0);
  const saved = cli.stdout.at(-1) as string;
  // The remote name cannot escape the output directory.
  expect(saved.startsWith(dir)).toBe(true);
  expect(sha(readFileSync(saved))).toBe(sha(data));
  await expect(a.page.getByTestId("file-card")).toContainText("Delivered to 1");
  await a.ctx.close();
  rmSync(dir, { recursive: true, force: true });
});

test("the CLI and a browser chat in the same room", async ({ browser }) => {
  const a = await member(browser);
  const link = await createRoom(a, "Browser");
  const cli = run(["chat", link, "--nick", "Terminal", ...NET]);
  await waitMembers(a.page, 1, 30_000);
  await say(a.page, "hello terminal");
  await expect
    .poll(() => cli.stdout.join("\n"), { timeout: 20_000 })
    .toContain("[Browser] hello terminal");
  cli.write("hello browser");
  await expect(a.page.getByTestId("messages")).toContainText("hello browser", { timeout: 20_000 });

  // Both ends show the same verification emojis ("verify together with Browser: 🐶 Dog  🐱 Cat  …").
  const prefix = "verify together with Browser: ";
  await expect.poll(() => cli.stderr.join("\n"), { timeout: 20_000 }).toContain(prefix);
  const line = cli.stderr.find((l) => l.includes(prefix)) as string;
  const cliNames = line
    .slice(line.indexOf(prefix) + prefix.length)
    .split("  ")
    .map((s) => s.slice(s.indexOf(" ") + 1));
  await a.page.getByRole("button", { name: "People", exact: true }).click();
  await a.page.getByTestId("verify").first().click();
  await expect(a.page.getByTestId("sas")).toBeVisible();
  expect(await a.page.locator("[data-testid=sas] .sas-name").allInnerTexts()).toEqual(cliNames);
  await a.page.keyboard.press("Escape");
  // The browser shows a delivery receipt from the CLI.
  await expect(a.page.locator(".msg.mine .receipt .tabular").first()).toHaveText("1", {
    timeout: 20_000,
  });
  cli.child.kill("SIGINT");
  await cli.exited;
  await expect(a.page.getByTestId("room")).toHaveAttribute("data-members", "0", {
    timeout: 20_000,
  });
  await a.ctx.close();
});
