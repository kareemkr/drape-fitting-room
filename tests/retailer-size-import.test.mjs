import assert from "node:assert/strict";
import test from "node:test";
import { handleImport } from "../lib/fitting/importer.mjs";
import { garmentSizingRecord } from "../lib/fitting/collections.js";
import { getGarmentSize } from "../lib/fitting/garment-size.js";

const url = "https://retailer.example.com/products/oxford";
const request = () =>
  new Request(
    "https://mirror.example.com/api/import?url=" + encodeURIComponent(url),
  );
const product = {
  "@type": "ProductGroup",
  name: "Oxford",
  image: "https://cdn.example.com/oxford.jpg",
};
const schemaScript = (obj) =>
  '<script type="application/ld+json">' + JSON.stringify(obj) + "</script>";
const qv = (field, value, unitCode = "CMT") => ({
  "@type": "QuantitativeValue",
  valueReference: "https://schema.org/WearableMeasurement" + field,
  unitCode,
  value,
});
const sized = (name, finished = [], body = []) => ({
  "@type": "Product",
  size: {
    "@type": "SizeSpecification",
    name,
    hasMeasurement: finished,
    suggestedMeasurement: body,
  },
});
async function importPage(markup) {
  let fetched = 0;
  const response = await handleImport(request(), async (address) => {
    assert.equal(address, url);
    fetched++;
    return new Response(markup, { headers: { "Content-Type": "text/html" } });
  });
  assert.equal(response.status, 200);
  assert.equal(fetched, 1);
  return response.json();
}

test("finished variant measurements use explicit photographed size and survive a wardrobe save", async () => {
  const variants = [
    sized("L", [qv("ChestOrBust", 44, "INH"), qv("Sleeve", 65)]),
    sized(
      "M",
      [qv("ChestOrBust", 40, "INH"), qv("Sleeve", 63)],
      [qv("Waist", 82)],
    ),
  ];
  const imported = await importPage(
    schemaScript({
      ...product,
      hasVariant: variants,
      additionalProperty: { name: "Size shown", value: "M" },
    }),
  );
  assert.deepEqual(imported.shopSizes, ["M", "L"]);
  assert.equal(imported.sizeChart.reference, "M");
  assert.deepEqual(imported.sizeChart.sizes, [
    { label: "M", chest: 101.6, sleeveLength: 63 },
    { label: "L", chest: 111.76, sleeveLength: 65 },
  ]);
  const garment = {
    category: "top",
    ...garmentSizingRecord({ ...imported, category: "top" }),
  };
  const up = getGarmentSize(garment, 1);
  assert.equal(up.label, "L");
  assert.ok(Math.abs(up.factors.chest - 1.1) < 1e-9);
  assert.equal(up.factors.sleeveLength, 65 / 63);
});

test("retail labels and body measurements cannot synthesize a garment chart", async () => {
  const imported = await importPage(
    schemaScript({
      ...product,
      hasVariant: [
        sized("M", [], [qv("ChestOrBust", 96)]),
        sized("S", [], [qv("ChestOrBust", 88)]),
      ],
    }) +
      "<h3>Body measurements (cm)</h3><table><tr><th>Size</th><th>Chest</th></tr><tr><td>S</td><td>88</td></tr><tr><td>M</td><td>96</td></tr></table>",
  );
  assert.deepEqual(imported.shopSizes, ["S", "M"]);
  assert.equal(imported.sizeChart, undefined);
  assert.equal(imported.chartDraft, undefined);
  assert.deepEqual(garmentSizingRecord(imported), { shopSizes: ["S", "M"] });
});

test("comparisons of a shop chart without a photo reference wait for explicit confirmation", async () => {
  const html =
    "<table><caption>Finished garment measurements in cm</caption><tr><th>Size</th><th>Pit to pit</th><th>Sleeve length</th></tr><tr><td>S</td><td>49</td><td>58.5</td></tr><tr><td>M</td><td>52</td><td>60</td></tr></table>";
  const imported = await importPage(schemaScript(product) + html);
  assert.equal(imported.sizeChart, undefined);
  const pending = garmentSizingRecord(imported);
  assert.deepEqual(pending.chartDraft.sizes, [
    { label: "S", chest: 98, sleeveLength: 58.5 },
    { label: "M", chest: 104, sleeveLength: 60 },
  ]);
  assert.equal(getGarmentSize(pending, 1).mode, "relative");
  assert.deepEqual(garmentSizingRecord({ ...pending, sizeChart: null }), {
    shopSizes: ["S", "M"],
  });
});

test("read transposed product tables with garment and length units explicitly declared", async () => {
  const html =
    "<h3>Garment measurements</h3><table><tr><th>Size</th><th>M</th><th>L</th></tr><tr><td>Waist circumference (cm)</td><td>80</td><td>84</td></tr><tr><td>Inseam (in)</td><td>30</td><td>31</td></tr></table>";
  const { chartDraft } = await importPage(schemaScript(product) + html);
  assert.deepEqual(chartDraft.sizes, [
    { label: "M", waist: 80, legLength: 76.2 },
    { label: "L", waist: 84, legLength: 78.74 },
  ]);
});

test("Shopify size variants stay scoped to the chosen item without using color or stock as measurements", async () => {
  const shopScript = (obj) =>
    '<script type="application/json">' + JSON.stringify(obj) + "</script>";
  const options = ["Color", "Size"];
  const html =
    shopScript({
      handle: "other-garment",
      options,
      variants: [{ option2: "Wrong" }],
    }) +
    shopScript({
      handle: "oxford",
      options,
      variants: [
        { option1: "Navy", option2: "L", available: false },
        { option1: "Blue", option2: "M" },
      ],
    });
  const imported = await importPage(schemaScript(product) + html);
  assert.deepEqual(imported.shopSizes, ["M", "L"]);
  assert.equal(imported.chartDraft, undefined);
});

test("measurement ambiguity or mismatched garment families cannot feed the size control", async () => {
  const variant = (n) =>
    sized(n, [qv("ChestOrBust", n === "M" ? 98 : "95–105")]);
  const other = {
    "@type": "Product",
    image: product.image,
    hasVariant: [sized("XXL", [qv("ChestOrBust", 180)])],
  };
  const html =
    schemaScript({
      "@graph": [
        { ...product, hasVariant: [variant("M"), variant("L")] },
        other,
      ],
    }) +
    "<h3>Garment measurements in the table below</h3><table><tr><th>Size</th><th>Chest</th></tr><tr><td>M</td><td>30</td></tr><tr><td>L</td><td>32</td></tr></table>";
  const imported = await importPage(html);
  assert.deepEqual(imported.shopSizes, ["M", "L"]);
  assert.equal(imported.chartDraft, undefined);
  assert.deepEqual(garmentSizingRecord({ category: "top" }), {});
});

test("extract the pictured reference and metric widths from merchant fit notes with rounded inch equivalents", async () => {
  // Measurement format and factual M and L dimensions from the published
  // Nobl Benson Over Shirt fit notes: https://noblclo.com/products/benson-over-shirt-khaki
  const notes = `<p>The model is wearing a size M.</p><p>Model body waist 86cm.</p>
    <p>Garment measurements: Chest (from pit to pit)<br>M: 59cm / 23.2&quot;<br>
    L: 63cm / 24.8&quot;</p><h3>Shipping</h3>`;
  const result = await importPage(schemaScript(product) + notes);
  assert.deepEqual(result.sizeChart, {
    unit: "cm",
    reference: "M",
    sizes: [
      { label: "M", chest: 118 },
      { label: "L", chest: 126 },
    ],
  });
  assert.ok(
    Math.abs(getGarmentSize(result, 1).factors.chest - 126 / 118) < 1e-9,
  );
  const mixed = await importPage(
    schemaScript(product) +
      notes.replace("Model body waist 86cm.", "Another model wears size L."),
  );
  assert.equal(mixed.sizeChart, undefined);
  assert.equal(mixed.chartDraft.reference, "");
});
