import test from "node:test";
import assert from "node:assert/strict";
import { getGarmentSize, normalizeSizeChart, sizeMeasurementFields, NEUTRAL_SIZE_GRADE } from "../lib/fitting/garment-size.js";

const shirt = {
  category: "top",
  sizeChart: {
    unit: "cm",
    reference: "M",
    sizes: [
      { label: "S", chest: 98, waist: 90, length: 65 },
      { label: "M", chest: 104, waist: 97, length: 67 },
      { label: "L", chest: 112, waist: 104, length: 69, sleeveLength: 63 },
      { label: "XL", chest: 121, waist: 110, length: 71, sleeveLength: 64 },
    ],
  },
};
const approx = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} / ${expected}`);

test("reference size is the identity, including when upgrading older wardrobe data", () => {
  for (const item of [null, {}, { name: "Old shirt", category: "top" }, shirt]) {
    assert.deepEqual(getGarmentSize(item).factors, NEUTRAL_SIZE_GRADE);
    for (const value of Object.values(getGarmentSize(item).factors)) assert.equal(value, 1);
  }
  assert.equal(getGarmentSize(shirt).label, "M");
  assert.equal(getGarmentSize({ shopSizes: ["XS", "S", "L"] }, 1).mode, "relative");
});

test("relative sizes move in bounded steps, and previous choices reproduce exactly", () => {
  const item = { category: "top" };
  const steps = [-50, -3, -2, -1, 0, 1, 2, 3, 50].map((n) => getGarmentSize(item, n));
  assert.deepEqual(steps.map((x) => x.step), [-3, -3, -2, -1, 0, 1, 2, 3, 3]);
  assert.equal(steps[3].label, "−1 size");
  assert.equal(steps[5].label, "+1 size");
  assert.equal(steps[6].label, "+2 sizes");
  let fit = getGarmentSize(item, 2);
  for (let index = 0; index < 8; index++) {
    fit = getGarmentSize(item, fit.step - 1);
    fit = getGarmentSize(item, fit.step + 1);
  }
  assert.deepEqual(fit, getGarmentSize(item, 2));
  for (const step of [NaN, Infinity, undefined, "2"]) assert.equal(getGarmentSize(item, step).step, 0);
  assert.equal(getGarmentSize(item, 1.9).step, 1);
});

test("a size grade adds ease without applying a uniform camera zoom", () => {
  for (const category of ["top", "bottom", "dress"]) {
    const f = getGarmentSize({ category }, 1);
    assert.deepEqual(f.estimatedDimensions, sizeMeasurementFields(category));
    assert.equal(f.measuredDimensions.length, 0);
    for (const field of sizeMeasurementFields(category)) {
      assert.ok(f.factors[field] > 1, category + " " + field);
      assert.ok(getGarmentSize({ category }, -1).factors[field] < 1);
    }
    assert.ok(f.factors.waist > f.factors.length);
  }
  assert.equal(getGarmentSize({ category: "top" }, 2).factors.legWidth, 1);
  assert.equal(getGarmentSize({ category: "bottom" }, 2).factors.shoulder, 1);
});

test("a measured retailer size uses that product's proportions and reference size", () => {
  const size = getGarmentSize(shirt, 1);
  assert.equal(size.mode, "chart");
  assert.equal(size.baseLabel, "M");
  assert.equal(size.label, "L");
  assert.equal(size.minStep, -1);
  assert.equal(size.maxStep, 2);
  approx(size.factors.chest, 112 / 104);
  approx(size.factors.waist, 104 / 97);
  approx(size.factors.length, 69 / 67);
  assert.deepEqual(size.measuredDimensions, ["chest", "waist", "length"]);
  assert.ok(size.estimatedDimensions.includes("sleeveLength"));
  assert.ok(size.factors.shoulder > 1 && size.factors.shoulder < size.factors.chest);
  assert.equal(getGarmentSize(shirt, -50).label, "S");
  assert.equal(getGarmentSize(shirt, 50).label, "XL");
  const unit = { ...shirt.sizeChart, unit: "in", sizes: shirt.sizeChart.sizes.map(({ label, ...dims }) => ({
    label, ...Object.fromEntries(Object.entries(dims).map(([k, n]) => [k, n / 2.54])),
  })) };
  const inInches = getGarmentSize({ ...shirt, sizeChart: unit }, 1);
  for (const field of Object.keys(size.factors)) approx(inInches.factors[field], size.factors[field]);
});

test("a chart can offer more than three larger sizes and identical-width inseams", () => {
  const sizes = ["28", "30", "31", "32", "33", "34", "36"].map((n) => ({
    label: "30/" + n, waist: 30, hip: 39.5, legLength: Number(n),
  }));
  const pants = { category: "bottom", sizeChart: { reference: "30/28", unit: "in", sizes } };
  const fit = getGarmentSize(pants, 6);
  assert.equal(fit.label, "30/36");
  assert.equal(fit.minStep, 0);
  assert.equal(fit.maxStep, 6);
  assert.equal(fit.factors.waist, 1);
  assert.equal(fit.factors.legWidth, 1);
  approx(fit.factors.legLength, 36 / 28);
  approx(fit.factors.length, 36 / 28);
  assert.ok(fit.estimatedDimensions.includes("length"));
});

test("incomplete, ambiguous and label-only retailer data falls back safely", () => {
  const valid = shirt.sizeChart;
  const malformed = [
    null, {}, { ...valid, reference: "" }, { ...valid, reference: "XS" },
    { ...valid, sizes: [{ label: "M", chest: 100 }] },
    { ...valid, sizes: [{ label: "M", chest: 100 }, { label: "m", chest: 110 }] },
    { ...valid, sizes: [{ label: "M", chest: 100 }, { label: "L", waist: 115 }] },
    { ...valid, sizes: [{ label: "M", chest: 100 }, { label: "L", chest: "100-104" }] },
    { ...valid, sizes: [{ label: "M", chest: 100 }, null] },
    { ...valid, sizes: [{ label: "M", chest: 100 }, { label: "L", chest: Infinity }] },
    { ...valid, sizes: [{ label: "M", legLength: 70 }, { label: "L", legLength: 76 }] },
    { ...valid, sizes: [{ label: "M", chest: 100 }, { label: "L", chest: -10 }] },
    { ...valid, unit: "unspecified" },
  ];
  for (const sizeChart of malformed) {
    assert.equal(normalizeSizeChart(sizeChart), null);
    assert.equal(getGarmentSize({ category: "top", sizeChart }, 1).mode, "relative");
  }
  const chart = normalizeSizeChart({
    ...valid, reference: "  m ", sizes: [{ label: "M", chest: "100", length: 0 }, { label: "L", chest: 105, length: "bad" }],
  });
  assert.equal(chart.reference, "M");
  assert.deepEqual(chart.sizes[0], { label: "M", chest: 100 });
  assert.deepEqual(normalizeSizeChart(chart), chart);
  assert.equal(shirt.sizeChart.sizes[1].label, "M");
});

test("extreme chart proportions are bounded and listed explicitly", () => {
  const item = {
    category: "top",
    sizeChart: { unit: "cm", reference: "A", sizes: [{ label: "A", chest: 65 }, { label: "B", chest: 210 }] },
  };
  const fit = getGarmentSize(item, 1);
  assert.ok(fit.factors.chest < 210 / 65);
  assert.ok(fit.measuredDimensions.includes("chest"));
  assert.ok(fit.limitedDimensions.includes("chest"));
  assert.ok(fit.estimatedDimensions.includes("waist"));
  for (const value of Object.values(fit.factors)) assert.ok(Number.isFinite(value) && value > 0);
});

test("two published product charts produce distinct M-to-L grades using their own finished measurements", () => {
  // AS Colour's paired Staple 5001 and Maple 4001 size guide, cm of flat width
  // and body length. The ratios also hold if both chest widths are doubled.
  // https://gocustom.com/img/cms/Size%20Guides/AS-Colour-Size-Guides.pdf
  const products = [
    { medium: [52, 75], large: [56.5, 78.5] },
    { medium: [50.5, 65.5], large: [53, 66.5] },
  ];
  const fits = products.map(({ medium, large }) => getGarmentSize({
    category: "top",
    sizeChart: {
      reference: "M", unit: "cm",
      sizes: [{ label: "M", chest: medium[0], length: medium[1] }, { label: "L", chest: large[0], length: large[1] }],
    },
  }, 1));
  approx(fits[0].factors.chest, 56.5 / 52);
  approx(fits[0].factors.length, 78.5 / 75);
  approx(fits[1].factors.chest, 53 / 50.5);
  approx(fits[1].factors.length, 66.5 / 65.5);
  assert.ok(fits[0].factors.chest > fits[1].factors.chest);
});

test("size up follows alpha and numeric grades even when entered largest first", () => {
  const inverted = { ...shirt, sizeChart: { ...shirt.sizeChart, sizes: [...shirt.sizeChart.sizes].reverse() } };
  assert.equal(getGarmentSize(inverted, 1).label, "L");
  const numeric = {
    category: "bottom", sizeChart: { unit: "cm", reference: "38", sizes: [
      { label: "42", hip: 110 }, { label: "40", hip: 104 }, { label: "38", hip: 98 },
    ] },
  };
  assert.equal(getGarmentSize(numeric, 1).label, "40");
  assert.equal(getGarmentSize(numeric, -1).step, 0);
  assert.deepEqual(inverted.sizeChart.sizes.map((r) => r.label), ["XL", "L", "M", "S"]);
});
