import { describe, expect, test } from "bun:test";
import { constraintsFor, openDevices } from "./devices";

const stream = {} as MediaStream;

function fakeGum(fail?: (c: MediaStreamConstraints) => string | null) {
  const calls: MediaStreamConstraints[] = [];
  const gum = async (c: MediaStreamConstraints) => {
    calls.push(c);
    const name = fail?.(c);
    if (name) throw new DOMException("fail", name);
    return stream;
  };
  return { gum, calls };
}

function exactOf(c: MediaStreamConstraints, kind: "audio" | "video") {
  const v = c[kind];
  return typeof v === "object" && typeof v.deviceId === "object" && !Array.isArray(v.deviceId)
    ? v.deviceId
    : undefined;
}

describe("devices", () => {
  test("the chosen device is requested exactly; the default microphone by its alias", () => {
    expect(constraintsFor("audio", "mic-2").deviceId).toEqual({ exact: "mic-2" });
    // Exact: Chrome ignores an ideal "default" and opens the device picked last on the site.
    expect(constraintsFor("audio", "").deviceId).toEqual({ exact: "default" });
    expect(constraintsFor("audio", "", false).deviceId).toBeUndefined();
    expect(constraintsFor("video", "").deviceId).toBeUndefined();
    expect(constraintsFor("video", "cam-1").deviceId).toEqual({ exact: "cam-1" });
  });

  test("opens exactly the selected devices", async () => {
    const { gum, calls } = fakeGum();
    const res = await openDevices({ audio: "mic-2", video: "cam-1" }, gum);
    expect(res.fellBack).toEqual([]);
    expect(exactOf(calls[0] as MediaStreamConstraints, "audio")).toEqual({ exact: "mic-2" });
    expect(exactOf(calls[0] as MediaStreamConstraints, "video")).toEqual({ exact: "cam-1" });
  });

  test("only what is asked for is opened", async () => {
    const { gum, calls } = fakeGum();
    await openDevices({ audio: "mic-2" }, gum);
    expect(calls[0]?.video).toBe(false);
  });

  test("a device that is gone falls back to the system default", async () => {
    const { gum, calls } = fakeGum((c) =>
      exactOf(c, "audio")?.exact === "unplugged-mic" ? "OverconstrainedError" : null,
    );
    const res = await openDevices({ audio: "unplugged-mic" }, gum);
    expect(res.fellBack).toEqual(["audio"]);
    expect(calls.length).toBe(2);
    expect(exactOf(calls[1] as MediaStreamConstraints, "audio")).toEqual({ exact: "default" });
  });

  test("a browser without the alias opens its own default, without a fallback warning", async () => {
    const { gum, calls } = fakeGum((c) => (exactOf(c, "audio") ? "OverconstrainedError" : null));
    const res = await openDevices({ audio: "", video: "" }, gum);
    expect(res.fellBack).toEqual([]);
    expect(calls.length).toBe(2);
    expect(exactOf(calls[1] as MediaStreamConstraints, "audio")).toBeUndefined();
  });

  test("a gone device on a browser without the alias still reaches its default", async () => {
    const { gum, calls } = fakeGum((c) => (exactOf(c, "audio") ? "OverconstrainedError" : null));
    const res = await openDevices({ audio: "unplugged-mic" }, gum);
    expect(res.fellBack).toEqual(["audio"]);
    expect(calls.length).toBe(3);
    expect(exactOf(calls[2] as MediaStreamConstraints, "audio")).toBeUndefined();
  });

  test("a refused permission is not retried", async () => {
    const { gum, calls } = fakeGum(() => "NotAllowedError");
    await expect(openDevices({ audio: "mic-2" }, gum)).rejects.toThrow();
    expect(calls.length).toBe(1);
    await expect(openDevices({ audio: "" }, gum)).rejects.toThrow();
    expect(calls.length).toBe(2);
  });

  test("no microphone at all fails once the default was asked without the alias too", async () => {
    const { gum, calls } = fakeGum(() => "NotFoundError");
    await expect(openDevices({ audio: "" }, gum)).rejects.toThrow();
    expect(calls.length).toBe(2);
  });
});
