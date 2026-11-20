// Finished chest, waist and hip values are full circumferences. The shopper
// measures one edge-to-edge width on a flat garment in the chart's own unit.
export function comparableWidths(chart, category) {
  const candidates = category === "bottom" ? ["waist", "hip"] : ["chest", "waist", "hip"];
  return candidates.filter((field) =>
    chart.sizes.every((row) => Number.isFinite(row[field])) &&
    new Set(chart.sizes.map((row) => row[field])).size >= 2
  );
}

export function matchFlatWidth(chart, field, input) {
  if (!chart || !["chest", "waist", "hip"].includes(field) || typeof input === "boolean") return null;
  const target = Number(input);
  if (!Number.isFinite(target) || target <= 0 || !comparableWidths(chart, "dress").includes(field)) return null;
  const widths = chart.sizes.map((row) => row[field] / 2);
  const reference = chart.sizes.findIndex((row) => row.label === chart.reference);
  if (reference < 0) return null;
  let best = 0;
  for (let i = 1; i < widths.length; i++) {
    const difference = Math.abs(widths[i] - target);
    const previous = Math.abs(widths[best] - target);
    if (difference < previous || (difference === previous && widths[i] > widths[best])) best = i;
  }
  return { label: chart.sizes[best].label, step: best - reference, flatWidth: widths[best],
    outside: target < Math.min(...widths) || target > Math.max(...widths) };
}
