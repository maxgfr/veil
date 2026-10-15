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
  // The default is asked as an ideal ("default"): only an exact device can be missing.
  return typeof v === "object" && typeof v.deviceId === "object" ? v.deviceId : undefined;
}

describe("devices", () => {
  test("the chosen device is requested exactly; the default is not pinned", () => {
    expect(constraintsFor("audio", "mic-2").deviceId).toEqual({ exact: "mic-2" });
    expect(constraintsFor("audio", "").deviceId).toBe("default");
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
    const { gum, calls } = fakeGum((c) => (exactOf(c, "audio") ? "OverconstrainedError" : null));
    const res = await openDevices({ audio: "unplugged-mic" }, gum);
    expect(res.fellBack).toEqual(["audio"]);
    expect(calls.length).toBe(2);
    expect(exactOf(calls[1] as MediaStreamConstraints, "audio")).toBeUndefined();
  });

  test("a refused permission is not retried", async () => {
    const { gum, calls } = fakeGum(() => "NotAllowedError");
    await expect(openDevices({ audio: "mic-2" }, gum)).rejects.toThrow();
    expect(calls.length).toBe(1);
  });

  test("the system default is not retried either", async () => {
    const { gum, calls } = fakeGum(() => "NotFoundError");
    await expect(openDevices({ audio: "" }, gum)).rejects.toThrow();
    expect(calls.length).toBe(1);
  });
});
