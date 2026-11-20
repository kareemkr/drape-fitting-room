// A visual grade is relative to the photographed garment. These proportions
// are preview defaults, not retailer sizes or a body-measurement chart.
const fields = Object.freeze({
  top: Object.freeze(["chest", "waist", "shoulder", "length", "sleeveWidth", "sleeveLength", "hip"]),
  bottom: Object.freeze(["waist", "hip", "legWidth", "legLength", "length"]),
  dress: Object.freeze(["chest", "waist", "hip", "shoulder", "length", "sleeveWidth", "sleeveLength", "legWidth", "legLength"]),
});
const increment = {
  top: { shoulder: 0.026, chest: 0.060, waist: 0.064, hip: 0.056, length: 0.024, sleeveWidth: 0.068, sleeveLength: 0.017 },
  bottom: { waist: 0.060, hip: 0.060, length: 0.022, legWidth: 0.065, legLength: 0.015 },
  dress: { shoulder: 0.024, chest: 0.055, waist: 0.065, hip: 0.060, length: 0.022, sleeveWidth: 0.064, sleeveLength: 0.017, legWidth: 0.060, legLength: 0.016 },
};

export const NEUTRAL_SIZE_GRADE = Object.freeze({
  shoulder: 1, chest: 1, waist: 1, hip: 1, length: 1,
  sleeveWidth: 1, sleeveLength: 1, legWidth: 1, legLength: 1,
});

const ratioLimits = {
  shoulder: [0.68, 1.52], chest: [0.54, 1.90], waist: [0.48, 2.10],
  hip: [0.54, 1.90], length: [0.55, 1.65], sleeveWidth: [0.48, 2.10],
  sleeveLength: [0.55, 1.65], legWidth: [0.48, 2.10], legLength: [0.55, 1.60],
};

function categoryOf(category) {
  return category === "bottom" || category === "dress" ? category : "top";
}

export function sizeMeasurementFields(category = "top") {
  return fields[categoryOf(category)];
}

function labelOf(input) {
  if (typeof input !== "string" && !Number.isFinite(input)) return "";
  const label = String(input).trim();
  return label.length <= 48 && !/[\u0000-\u001f\u007f]/u.test(label) ? label : "";
}

function dimension(value, unit) {
  if (typeof value === "string") {
    const text = value.trim();
    if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/u.test(text)) return null;
    value = Number(text);
  }
  if (!Number.isFinite(value)) return null;
  const centimeters = value * (unit === "in" ? 2.54 : 1);
  return centimeters >= 1 && centimeters <= 400 ? value : null;
}

// Retailers sometimes display their largest size first. Standard alpha and
// numeric runs have a known order; keep the supplied order for custom labels
// such as waist/inseam combinations or regional fit names.
function orderedRows(sizes) {
  const alpha = ["4XS", "3XS", "2XS", "XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL", "6XL", "7XL", "8XL"];
  const labels = sizes.map(({ label }) => label.trim().toUpperCase());
  const numeric = labels.every((label) => /^\d+(?:\.\d+)?$/u.test(label));
  const ranks = numeric ? labels.map(Number) : labels.map((label) => {
    const canonical = label.replace(/^(X{2,})([SL])$/u, (_, count, side) => count.length + "X" + side);
    return alpha.indexOf(canonical);
  });
  if (ranks.includes(-1) || new Set(ranks).size !== sizes.length) return sizes;
  return sizes.map((row, i) => ({ row, rank: ranks[i] }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ row }) => row);
}

// Each row describes the finished garment measured the same way and in the
// same unit. Explicit order matters for retail labels such as 30/32 and 30/34.
// Reject ambiguous charts as a unit so "+" cannot skip an unmeasured row.
export function normalizeSizeChart(chart, category = "top") {
  if (!chart || !Array.isArray(chart.sizes) || chart.sizes.length < 2 || chart.sizes.length > 80) return null;
  const { unit } = chart;
  if (unit !== "cm" && unit !== "in") return null;
  const reference = labelOf(chart.reference).toLowerCase();
  const names = new Set();
  const sizes = [];
  const relevant = sizeMeasurementFields(category);
  for (const raw of chart.sizes) {
    const label = labelOf(raw?.label);
    const key = label.toLowerCase();
    if (!label || names.has(key)) return null;
    names.add(key);
    const row = { label };
    for (const field of relevant) {
      const value = dimension(raw[field], unit);
      if (value !== null) row[field] = value;
    }
    sizes.push(row);
  }
  const base = sizes.find((row) => row.label.toLowerCase() === reference);
  if (!base || !sizes.every((row) => relevant.some((field) => base[field] !== undefined && row[field] !== undefined))) return null;
  return { unit, reference: base.label, sizes: orderedRows(sizes) };
}

function relativeLabel(step) {
  if (step === 0) return "Reference";
  return (step > 0 ? "+" : "−") + Math.abs(step) + (Math.abs(step) === 1 ? " size" : " sizes");
}

function clampStep(step, min, max) {
  const integer = Number.isFinite(step) ? Math.trunc(step) : 0;
  return Math.max(min, Math.min(max, integer));
}

function measuredRatios(base, target, relevant) {
  const ratios = {};
  if (base && target) {
    for (const field of relevant) {
      if (base[field] !== undefined && target[field] !== undefined) ratios[field] = target[field] / base[field];
    }
  }
  return ratios;
}

function widthStep(ratios, rates, category, fallback) {
  // Only an explicitly measured girth can estimate another missing width.
  // If reported waist and hip stay the same across inseams, widths stay fixed.
  const girths = category === "bottom" ? ["waist", "hip"] : ["chest", "waist", "hip"];
  const observed = girths
    .filter((field) => ratios[field] !== undefined)
    .map((field) => (ratios[field] - 1) / rates[field])
    .sort((a, b) => a - b);
  if (!observed.length) return fallback;
  const middle = Math.floor(observed.length / 2);
  return observed.length % 2 ? observed[middle] : (observed[middle - 1] + observed[middle]) / 2;
}

const widths = new Set(["shoulder", "chest", "waist", "hip", "sleeveWidth", "legWidth"]);

/** The renderer consumes factors; the two controls consume bounds, labels and provenance. */
export function getGarmentSize(item, requestedStep = 0) {
  const category = categoryOf(item?.category);
  const chart = normalizeSizeChart(item?.sizeChart, category);
  const baseIndex = chart ? chart.sizes.findIndex((row) => row.label === chart.reference) : 0;
  const minStep = chart ? 0 - baseIndex : -3;
  const maxStep = chart ? chart.sizes.length - 1 - baseIndex : 3;
  const step = clampStep(requestedStep, minStep, maxStep);
  const base = chart?.sizes[baseIndex];
  const target = chart?.sizes[baseIndex + step];
  const relevant = fields[category];
  const rates = increment[category];
  const ratios = measuredRatios(base, target, relevant);
  const girthStep = widthStep(ratios, rates, category, step);
  const factors = { ...NEUTRAL_SIZE_GRADE };
  const measuredDimensions = [], estimatedDimensions = [], limitedDimensions = [];
  for (const field of relevant) {
    let ratio = ratios[field];
    if (ratio === undefined) {
      estimatedDimensions.push(field);
      const otherLength = field === "legLength" ? "length" : field === "length" ? "legLength" : null;
      if (category === "bottom" && otherLength && ratios[otherLength] !== undefined) {
        ratio = ratios[otherLength];
      } else {
        ratio = 1 + rates[field] * (widths.has(field) ? girthStep : step);
      }
    } else {
      measuredDimensions.push(field);
    }
    const [low, high] = ratioLimits[field];
    const bounded = Math.max(low, Math.min(high, ratio));
    if (bounded !== ratio) limitedDimensions.push(field);
    factors[field] = bounded;
  }
  return {
    step, minStep, maxStep, mode: chart ? "chart" : "relative",
    label: target?.label ?? relativeLabel(step), baseLabel: base?.label ?? "Reference",
    factors: step === 0 ? NEUTRAL_SIZE_GRADE : factors,
    measuredDimensions, estimatedDimensions, limitedDimensions,
  };
}
