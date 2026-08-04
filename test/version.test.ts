import { expect, test } from "bun:test";
import { CONDUCTOR_VERSION } from "../src/index.js";

test("exports the package contract version", () => {
  expect(CONDUCTOR_VERSION).toBe("0.1.0");
});
