/**
 * Static server for dist/ with a mock Nostr relay (/relay) and WebTorrent
 * tracker (/tracker) on the same origin, so the CSP's connect-src 'self'
 * allows them and tests never touch the public network.
 */
import { join, normalize } from "node:path";
import { createMockRelay, type MockRelay } from "./mock-relay";
import { createMockTracker, type MockTracker } from "./mock-tracker";

interface WsData {
  kind: "relay" | "tracker";
}

export interface AppServer {
  port: number;
  relay: MockRelay;
  tracker: MockTracker;
  stop(): void;
}

export function serveApp(opts: { port: number; dir: string }): AppServer {
  const relay = createMockRelay();
  const tracker = createMockTracker();
  const server = Bun.serve<WsData>({
    port: opts.port,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/relay" || url.pathname === "/tracker") {
        const kind = url.pathname === "/relay" ? "relay" : "tracker";
        if (srv.upgrade(req, { data: { kind } })) return undefined;
        return new Response("upgrade required", { status: 426 });
      }
      let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
      if (path.endsWith("/")) path += "index.html";
      const file = Bun.file(join(opts.dir, path));
      if (!(await file.exists())) return new Response("not found", { status: 404 });
      const headers: Record<string, string> = {};
      if (path.endsWith(".webmanifest")) headers["content-type"] = "application/manifest+json";
      return new Response(file, { headers });
    },
    websocket: {
      open(ws) {
        (ws.data.kind === "relay" ? relay : tracker).open(ws);
      },
      message(ws, msg) {
        const text = typeof msg === "string" ? msg : new TextDecoder().decode(msg);
        (ws.data.kind === "relay" ? relay : tracker).message(ws, text);
      },
      close(ws) {
        (ws.data.kind === "relay" ? relay : tracker).close(ws);
      },
      maxPayloadLength: 1 << 20,
    },
  });
  return {
    port: server.port ?? opts.port,
    relay,
    tracker,
    stop: () => server.stop(true),
  };
}
