// Read only data embedded in the already fetched product page. A size label,
// a body-size recommendation and a finished-garment measurement are distinct.
const list = (value) =>
  value == null ? [] : Array.isArray(value) ? value : [value];
const clean = (input) =>
  typeof input === "number" || typeof input === "string"
    ? String(input)
        .replace(/[\u0000-\u001f]+/g, " ")
        .trim()
        .slice(0, 40)
    : "";
const key = (value) => clean(value).toLowerCase();
const fields = {
  wearablemeasurementchestorbust: "chest",
  wearablemeasurementwaist: "waist",
  wearablemeasurementhips: "hip",
  wearablemeasurementsleeve: "sleeveLength",
  wearablemeasurementlength: "length",
  wearablemeasurementinseam: "legLength",
};
const inch = /^(?:inh|in\.?|inch|inches|")$/i;
const cent = /^(?:cmt|cm|centimet(?:re|er)s?)$/i;
function cm(value, unit) {
  const raw = String(value ?? "").trim();
  if (!/^\d{1,3}(?:[.,]\d{1,3})?$/.test(raw)) return undefined;
  const v = Number(raw.replace(",", "."));
  const result = inch.test(unit) ? v * 2.54 : cent.test(unit) ? v : 0;
  return result > 0 && result <= 350
    ? Math.round(result * 1000) / 1000
    : undefined;
}
function measuredProperty(value) {
  const ref = value?.valueReference?.["@id"] ?? value?.valueReference;
  return fields[key(typeof ref === "string" ? ref.split(/[\/#]/).at(-1) : "")];
}
function idOf(p) {
  return typeof p === "string" ? p : p?.["@id"];
}
function sameProduct(a, b) {
  return a === b || Boolean(idOf(a) && idOf(a) === idOf(b));
}
function readVariants(product, all) {
  const resolve = (v) => all.find((p) => sameProduct(v, p)) || v;
  const group = product.hasVariant
    ? product
    : all.find(
        (p) =>
          list(p.hasVariant).some((v) => sameProduct(v, product)) ||
          sameProduct(p, product.isVariantOf) ||
          (product.inProductGroupWithID &&
            product.inProductGroupWithID === p.productGroupID),
      );
  return [product, ...list(group?.hasVariant).slice(0, 64).map(resolve)];
}

const orderedLabels = [
  "xxxs",
  "xxs",
  "xs",
  "s",
  "m",
  "l",
  "xl",
  "xxl",
  "xxxl",
  "xxxxl",
  "xxxxxl",
];
function rank(label) {
  const txt = key(label)
    .replace(/\s/g, "")
    .replace(/^([2-5])xl$/, (_, n) => "x".repeat(Number(n)) + "l");
  if (/^\d+(?:\.\d+)?$/.test(txt)) return [1, Number(txt)];
  const i = orderedLabels.indexOf(txt);
  return i < 0 ? null : [0, i];
}
function ordered(items, getLabel) {
  const ranks = items.map((item) => rank(getLabel(item)));
  if (!ranks.every((r) => r && r[0] === ranks[0][0])) return items;
  return items
    .map((item, i) => [item, ranks[i][1]])
    .sort((a, b) => a[1] - b[1])
    .map(([item]) => item);
}

function shopifyLabels(markup, product, page, attrs) {
  const labels = [];
  const handle = page.pathname.match(/\/products\/([^/]+)\/?$/i)?.[1];
  for (const script of markup.matchAll(
    /<script\b([^>]{0,4096})>([\s\S]*?)<\/script\s*>/gi,
  )) {
    if (
      attrs(script[1]).type?.toLowerCase() !== "application/json" ||
      script[2].length > 512000
    )
      continue;
    let data;
    try {
      data = JSON.parse(script[2]);
    } catch {
      continue;
    }
    const record = data?.product ?? data;
    if (!Array.isArray(record?.options) || !Array.isArray(record.variants))
      continue;
    // Quick-buy widgets and recommendations can embed other products' variants.
    if (
      !(handle && record.handle === handle) &&
      !(product.name && key(record.title) === key(product.name))
    )
      continue;
    const i = record.options.findIndex((o) =>
      /^size$/i.test(clean(o?.name ?? o)),
    );
    if (i < 0 || i > 2) continue;
    for (const v of record.variants.slice(0, 256)) {
      const label = clean(v?.options?.[i] ?? v?.["option" + (i + 1)]);
      if (label) labels.push(label);
    }
  }
  return labels;
}

const headerFields = [
  [/pit\s*to\s*pit|chest|bust/, "chest"],
  [/waist/, "waist"],
  [/hip|seat/, "hip"],
  [/sleeve width|bicep|upper arm/, "sleeveWidth"],
  [/sleeve|overarm/, "sleeveLength"],
  [/inseam|inside leg/, "legLength"],
  [/thigh/, "legWidth"],
  [
    /^(?:body |garment |back |centre back |center back |shirt |dress |skirt |full |total )?length\b/,
    "length",
  ],
  [/shoulder/, "shoulder"],
];
function tableField(header, context) {
  const v = header.toLowerCase().replace(/[-_]/g, " ").trim();
  if (
    /to fit|suits|recommended|body circumference|cuff|opening|hem width|\brise\b/.test(
      v,
    )
  )
    return null;
  const field = headerFields.find(([pattern]) => pattern.test(v))?.[1];
  if (!field) return null;
  const around = ["chest", "waist", "hip", "legWidth", "sleeveWidth"].includes(
    field,
  );
  const flat =
    /pit[\s-]*to[\s-]*pit|half|1\s*\/\s*2|width|across|lay(?:ing)? flat|laid flat/i.test(
      header,
    ) ||
    /measured flat|measurements? (?:taken |measured )?(?:laying |laid )?flat|flat lay measurements?/i.test(
      context,
    );
  return {
    field,
    half: around && flat && !/circumference|around/i.test(header),
  };
}
function tableUnit(text) {
  const matches = [
    ...text
      .toLowerCase()
      .matchAll(/\b(cm|centimet(?:re|er)s?|inches|inch|in)\b/g),
  ].map((m) => (cent.test(m[1]) ? "cm" : "in"));
  // Only accept standalone "in" as a unit inside a header or explicit parenthesis.
  const normalized = text.toLowerCase();
  if (
    !/\binch(?:es)?\b|[([]\s*in\.?\s*[)\]]|(?:^|\s)in\.?\s*$|units?\s*[:=]\s*in\b/.test(
      normalized,
    )
  ) {
    for (let i = matches.length - 1; i >= 0; i--)
      if (matches[i] === "in") matches.splice(i, 1);
  }
  const unique = [...new Set(matches)];
  return unique.length === 1 ? unique[0] : null;
}
function cellMeasurement(raw, defaultUnit) {
  const text = String(raw ?? "")
    .trim()
    .replace(/[”″]/g, '"');
  const bare = cm(text, defaultUnit);
  if (bare !== undefined) return bare;
  // Dual-unit values are common. A dash here means a size range, not a dimension.
  const pair =
    /^(\d{1,3}(?:[.,]\d+)?)\s*(cm|inches|in\.?|inch|")(?:\s*\/\s*(\d{1,3}(?:[.,]\d+)?)\s*(cm|inches|in\.?|inch|"))?\.?$/i.exec(
      text,
    );
  if (!pair) return undefined;
  const a = cm(pair[1], pair[2]);
  if (!pair[3]) return a;
  const b = cm(pair[3], pair[4]);
  if (
    a === undefined ||
    b === undefined ||
    Math.abs(a - b) > Math.max(1.5, a * 0.02)
  )
    return undefined;
  return cent.test(pair[2]) ? a : b;
}

function stripMarkup(html) {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

// Some merchants print a clearly titled list of measurements under their fit notes.
function measuredList(visible, label, permittedLabels) {
  const lines = visible
    .replace(/<br\b[^>]*>|<\/(?:p|div|li|h[1-6]|summary|section)\s*>/gi, "\n")
    .split(/\n/)
    .map((line) => label(line, 500))
    .filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const heading =
      /^(?:finished |actual )?(?:garment|product|item) measurements?\s*[:–-]\s*(.{2,100})$/i.exec(
        lines[i],
      );
    if (!heading) continue;
    const metric = tableField(heading[1], lines[i]);
    if (!metric) continue;
    const rows = [];
    for (const line of lines.slice(i + 1, i + 65)) {
      const record =
        /^(?:size\s+)?([a-z0-9][a-z0-9 /-]{0,17})\s*:\s*(.+)$/i.exec(line);
      if (!record) break;
      const size = clean(record[1]);
      if (permittedLabels.size && !permittedLabels.has(key(size))) break;
      const measured = cellMeasurement(record[2], tableUnit(heading[1]));
      if (measured === undefined) break;
      rows.push({
        label: size,
        [metric.field]: measured * (metric.half ? 2 : 1),
      });
    }
    if (rows.length >= 2) {
      const near = lines.slice(Math.max(0, i - 6), i).join(" ");
      // More than one pictured size is ambiguous; keep the measurements for confirmation.
      const hints = [
        ...near.matchAll(
          /\b(?:wears|is wearing|shown in)\s+(?:a\s+)?size\s+([a-z0-9-]{1,12})\b/gi,
        ),
      ].map((m) => key(m[1]));
      const agreed = [...new Set(hints)];
      return { rows, reference: agreed.length === 1 ? agreed[0] : "" };
    }
  }
  return { rows: [], reference: "" };
}

function measuredTable(html, label, permittedLabels) {
  const noScripts = html;
  for (const match of noScripts.matchAll(
    /<table\b([^>]{0,4096})>([\s\S]*?)<\/table\s*>/gi,
  )) {
    const body = match[2];
    if (body.length > 100000 || /<table\b/i.test(body)) continue;
    const before = noScripts.slice(Math.max(0, match.index - 900), match.index);
    const nearest =
      [
        ...before.matchAll(
          /<(h[1-6]|summary|strong|p)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi,
        ),
      ].at(-1)?.[2] ?? "";
    const caption =
      body.match(/<caption\b[^>]*>([\s\S]*?)<\/caption>/i)?.[1] ?? "";
    const context = label([caption, nearest, match[1]].join(" "), 900).replace(
      /[-_]/g,
      " ",
    );
    if (
      !/(?:finished|actual|flat\s+lay|garment|product|item)\s+(?:size\s+)?measurements?|measurements?\s+(?:of|for)\s+(?:the\s+)?(?:garment|item|product)/i.test(
        context,
      ) ||
      /(?:body|model)\s+(?:size\s+)?measurements?|recommended\s+body/i.test(
        context,
      )
    )
      continue;
    const cells = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)]
      .slice(0, 65)
      .map((row) =>
        [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/gi)]
          .slice(0, 25)
          .map((cell) => label(cell[1], 100)),
      );
    const header = cells.findIndex(
      (row) =>
        row.length > 1 &&
        /^(?:(?:garment\s+)?size|measurements?|dimensions?)\b/i.test(row[0]),
    );
    if (header < 0) continue;
    let headings = cells[header];
    let data = cells.slice(header + 1);
    const unitContext = context.replace(/\bin\s+(?=cm|inches)/gi, "");
    const defaultUnit = tableUnit(headings[0]) || tableUnit(unitContext);
    // Size charts can put the size labels in either the first row or the first column.
    if (!headings.slice(1).some((h) => tableField(h, context))) {
      const measurementRows = data.filter((row) =>
        tableField(row[0] || "", context),
      );
      if (!measurementRows.length) continue;
      data = headings
        .slice(1)
        .map((size, i) => [size, ...measurementRows.map((row) => row[i + 1])]);
      headings = ["Size", ...measurementRows.map((row) => row[0])];
    }
    const defs = headings.map((name) => ({
      metric: tableField(name, context),
      unit: tableUnit(name) || defaultUnit,
    }));
    const rows = [];
    for (const [name, ...values] of data) {
      if (
        !name ||
        name.length > 22 ||
        (permittedLabels.size && !permittedLabels.has(key(name)))
      )
        continue;
      const row = { label: clean(name) };
      values.forEach((v, index) => {
        const { metric, unit } = defs[index + 1] || {};
        if (!metric) return;
        const measure = cellMeasurement(v, unit);
        if (measure !== undefined)
          row[metric.field] = measure * (metric.half ? 2 : 1);
      });
      if (Object.keys(row).length > 1) rows.push(row);
    }
    if (rows.length > 1) return rows;
  }
  return [];
}

export function retailerSizing(markup, product, all, page, { label, attrs }) {
  const variants = readVariants(product, all);
  const names = new Map(),
    rows = new Map(),
    conflict = new Set();
  const addName = (name) => {
    if (clean(name) && names.size < 64) names.set(key(name), clean(name));
  };
  for (const label of shopifyLabels(markup, product, page, attrs))
    addName(label);
  for (const variant of variants) {
    for (const size of list(variant?.size)) {
      const name = clean(size?.name ?? size);
      if (!name) continue;
      addName(name);
      const k = key(name);
      const row = rows.get(k) ?? { label: name };
      for (const entry of [
        ...list(size?.hasMeasurement),
        ...list(variant.hasMeasurement),
      ]) {
        const f = measuredProperty(entry);
        const v = cm(entry?.value, entry?.unitCode || entry?.unitText || "");
        if (!f || v === undefined) continue;
        if (row[f] !== undefined && row[f] !== v) conflict.add(k);
        row[f] = v;
      }
      if (Object.keys(row).length > 1) rows.set(k, row);
    }
  }
  let sizes = [...rows.values()].filter((r) => !conflict.has(key(r.label)));
  let picturedSize = "";
  if (sizes.length < 2 && /measurements?/i.test(markup)) {
    const visible = stripMarkup(markup);
    const allowed = new Set(names.keys());
    sizes = measuredTable(visible, label, allowed);
    if (sizes.length < 2) {
      const notes = measuredList(visible, label, allowed);
      sizes = notes.rows;
      picturedSize = notes.reference;
    }
  }
  for (const row of sizes) addName(row.label);
  const result = {};
  if (names.size) result.shopSizes = ordered([...names.values()], (n) => n);
  if (sizes.length > 1) {
    const reference =
      list(product.additionalProperty).find((p) =>
        /^(?:photographed size|size shown|sample size pictured)$/i.test(
          clean(p?.name),
        ),
      )?.value || picturedSize;
    const chart = {
      unit: "cm",
      reference: "",
      sizes: ordered(sizes, (r) => r.label),
    };
    const ref = chart.sizes.find((r) => key(r.label) === key(reference));
    if (ref) result.sizeChart = { ...chart, reference: ref.label };
    else result.chartDraft = chart;
  }
  return result;
}
