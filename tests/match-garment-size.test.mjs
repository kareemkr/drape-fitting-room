import assert from "node:assert/strict";
import test from "node:test";
import { comparableWidths, matchFlatWidth } from "../lib/fitting/match-garment-size.js";

const chart = { unit: "cm", reference: "Medium", sizes: [
  { label: "Small", chest: 96, waist: 90 }, { label: "Medium", chest: 104 }, { label: "Large", chest: 112 },
] };

test("a flat 55 cm chest matches the 112 cm finished garment, and a tie selects the roomier row", () => {
  for (const width of [54, "55", 56]) assert.deepEqual(matchFlatWidth(chart, "chest", width),
    { label: "Large", step: 1, flatWidth: 56, outside: false });
  assert.equal(matchFlatWidth(chart, "chest", 60).outside, true);
  assert.equal(matchFlatWidth(chart, "chest", 48).step, -1);
});

test("a measurement match requires comparable chart dimensions and a positive input", () => {
  assert.deepEqual(comparableWidths(chart, "top"), ["chest"]);
  assert.deepEqual(comparableWidths(chart, "bottom"), []);
  for (const value of ["", 0, Infinity, -1]) assert.equal(matchFlatWidth(chart, "chest", value), null);
  assert.equal(matchFlatWidth(chart, "waist", 46), null);
});
