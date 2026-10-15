import { describe, expect, test } from "bun:test";
import type { TransportState } from "../signal/types";
import { connectionSummary, transportLabel } from "./connection";

const relay = (state: TransportState) => ({ state });

describe("connectionSummary", () => {
  test("offline wins over everything", () => {
    const s = connectionSummary({
      online: false,
      transports: [relay("online")],
      others: [{ link: "connected" }],
    });
    expect(s).toMatchObject({ tone: "bad", label: "Offline" });
  });

  test("a connected peer means connected", () => {
    const s = connectionSummary({
      online: true,
      transports: [relay("error")],
      others: [{ link: "reconnecting" }, { link: "connected" }],
    });
    expect(s).toMatchObject({ tone: "ok", label: "Connected" });
  });

  test("a reconnecting peer waits, never red", () => {
    const s = connectionSummary({
      online: true,
      transports: [relay("error")],
      others: [{ link: "reconnecting" }],
    });
    expect(s).toMatchObject({ tone: "wait", label: "Reconnecting" });
  });

  test("an online relay without peers looks for peers", () => {
    const s = connectionSummary({
      online: true,
      transports: [relay("error"), relay("online")],
      others: [{ link: null }],
    });
    expect(s).toMatchObject({ tone: "wait", label: "Looking for peers" });
  });

  test("a connecting relay is still being reached", () => {
    const s = connectionSummary({
      online: true,
      transports: [relay("connecting"), relay("error")],
      others: [],
    });
    expect(s).toMatchObject({ tone: "wait", label: "Reaching relays" });
  });

  test("no relay reachable", () => {
    const s = connectionSummary({
      online: true,
      transports: [relay("error"), relay("off")],
      others: [],
    });
    expect(s).toMatchObject({ tone: "bad", label: "No relay reachable" });
  });
});

test("transportLabel names each transport", () => {
  expect(transportLabel("nostr")).toBe("Nostr relays");
  expect(transportLabel("torrent")).toBe("WebTorrent trackers");
  expect(transportLabel("manual")).toBe("Manual codes");
});
