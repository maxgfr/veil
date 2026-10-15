import { describe, expect, test } from "bun:test";
import { type Availability, availabilityOf } from "./builtin";

/** An API whose `availability()` answers `answer`, whatever its type. */
function api(answer: unknown) {
  return { availability: async () => answer as Availability };
}

describe("availabilityOf", () => {
  test("the four answers pass through", async () => {
    for (const a of ["available", "downloadable", "downloading", "unavailable"] as const)
      expect(await availabilityOf(api(a), {})).toBe(a);
  });

  test("anything else is unavailable, so a row is never blank", async () => {
    expect(await availabilityOf(api("readily"), {})).toBe("unavailable");
    expect(await availabilityOf(api(undefined), {})).toBe("unavailable");
    expect(await availabilityOf(api(null), {})).toBe("unavailable");
    expect(await availabilityOf(api({ state: "available" }), {})).toBe("unavailable");
  });

  test("a missing API or a probe that throws is unavailable", async () => {
    expect(await availabilityOf(undefined, {})).toBe("unavailable");
    const throwing = {
      availability: async (): Promise<Availability> => {
        throw new Error("bad language tag");
      },
    };
    expect(await availabilityOf(throwing, {})).toBe("unavailable");
  });
});
