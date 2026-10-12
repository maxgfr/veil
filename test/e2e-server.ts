/** Server for the Playwright suite: dist/ plus a local relay and tracker, no public network. */
import { resolve } from "node:path";
import { serveApp } from "./serve";

const port = Number(process.env.PORT ?? 4173);
const server = serveApp({ port, dir: resolve(import.meta.dir, "../dist") });
console.log(`e2e server on http://localhost:${server.port}/`);
