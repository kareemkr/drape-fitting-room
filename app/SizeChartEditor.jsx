"use client";

import { useState } from "react";
import {
  normalizeSizeChart,
  sizeMeasurementFields,
} from "../lib/fitting/garment-size.js";
import "./size-chart.css";

const names = {
  chest: "Chest around",
  waist: "Waist around",
  hip: "Hips around",
  shoulder: "Shoulder to shoulder",
  length: "Garment length",
  sleeveLength: "Sleeve length",
  sleeveWidth: "Upper arm around",
  legWidth: "Thigh around",
  legLength: "Inseam",
};

function startingRows(item) {
  const chart = item.sizeChart || item.chartDraft;
  const labels = Array.isArray(item.shopSizes)
    ? item.shopSizes.slice(0, 64)
    : [];
  if (chart?.sizes?.length) return chart.sizes.map((row) => ({ ...row }));
  if (labels.length >= 2) return labels.map((label) => ({ label }));
  return [{ label: labels[0] || "" }, { label: "" }];
}

export default function SizeChartEditor({ item, onSave, onCancel }) {
  const stored = item.sizeChart || item.chartDraft;
  const [rows, setRows] = useState(() => startingRows(item));
  const [unit, setUnit] = useState(stored?.unit === "in" ? "in" : "cm");
  const [reference, setReference] = useState(() =>
    stored?.reference
      ? rows.findIndex((row) => row.label === stored.reference)
      : -1,
  );
  const fields = sizeMeasurementFields(item.category);
  const [shown, setShown] = useState(() =>
    fields.filter(
      (f) =>
        f === fields[0] || f === "length" || rows.some((row) => row[f] > 0),
    ),
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function edit(index, field, value) {
    setRows((prev) =>
      prev.map((r, i) => (i === index ? { ...r, [field]: value } : r)),
    );
    setError("");
  }
  function setMeasurementUnit(next) {
    if (next === unit) return;
    const multiplier = next === "in" ? 1 / 2.54 : 2.54;
    setRows((prev) =>
      prev.map((row) => {
        const adjusted = { ...row };
        for (const f of fields) {
          const v = Number(row[f]);
          if (Number.isFinite(v) && v > 0)
            adjusted[f] = Number((v * multiplier).toFixed(4));
        }
        return adjusted;
      }),
    );
    setUnit(next);
  }
  function removeRow(index) {
    setRows((prev) => prev.filter((_, i) => i !== index));
    if (reference === index) setReference(-1);
    else if (reference > index) setReference(reference - 1);
    setError("");
  }
  async function persist(chart) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onSave(chart);
    } catch (e) {
      setError(e?.message || "Could not save this chart on this device.");
    } finally {
      setBusy(false);
    }
  }
  function submit(event) {
    event.preventDefault();
    const labels = rows.map((row) => String(row.label).trim());
    if (reference < 0 || !labels[reference]) {
      setError("Choose the size shown in the product photo as the reference.");
      return;
    }
    if (
      labels.some((label) => !label) ||
      new Set(labels.map((l) => l.toLowerCase())).size !== labels.length
    ) {
      setError("Give every row a different size label, or remove unused rows.");
      return;
    }
    // The first reference measurement shared by each row establishes at least
    // one measured size ratio. A half-completed chart should stay in the editor.
    const input = rows.map((row, i) => {
      const clean = { label: labels[i] };
      for (const f of shown) {
        if (row[f] !== "" && row[f] != null) clean[f] = Number(row[f]);
      }
      return clean;
    });
    const chart = normalizeSizeChart(
      { unit, reference: labels[reference], sizes: input },
      item.category,
    );
    if (
      !chart ||
      chart.sizes.length !== rows.length ||
      input.some((row) =>
        Object.keys(row).some(
          (f) =>
            f !== "label" &&
            !(chart.sizes.find((r) => r.label === row.label)?.[f] > 0),
        ),
      )
    ) {
      setError(
        "Enter a valid finished-garment measurement shared with the reference for every size.",
      );
      return;
    }
    void persist(chart);
  }

  return (
    <form className="size-chart-editor" onSubmit={submit}>
      <p className="dialog-copy">
        Enter the finished measurements of {item.name || "this garment"} from
        smallest to largest. For “around” measurements, double the width
        measured across a garment laid flat.
      </p>
      <div className="chart-fields">
        <label className="field-label">
          Measurement unit
          <select
            value={unit}
            onChange={(e) => setMeasurementUnit(e.target.value)}
            disabled={busy}
          >
            <option value="cm">Centimetres</option>
            <option value="in">Inches</option>
          </select>
        </label>
        <label className="field-label">
          Size shown in the product photo
          <select
            value={reference}
            onChange={(e) => {
              setReference(Number(e.target.value));
              setError("");
            }}
            disabled={busy}
          >
            <option value={-1}>Choose reference size</option>
            {rows.map((row, i) => (
              <option key={i} value={i} disabled={!row.label.trim()}>
                {row.label || "Unnamed size"}
              </option>
            ))}
          </select>
        </label>
      </div>
      <details className="chart-measurements">
        <summary>Measurements to include</summary>
        <div>
          {fields.map((f) => (
            <label key={f}>
              <input
                type="checkbox"
                checked={shown.includes(f)}
                disabled={busy}
                onChange={(e) =>
                  setShown(
                    e.target.checked
                      ? fields.filter((a) => shown.includes(a) || a === f)
                      : shown.filter((a) => a !== f),
                  )
                }
              />
              {names[f]}
            </label>
          ))}
        </div>
      </details>
      <div
        className="chart-table-wrap"
        tabIndex={0}
        role="region"
        aria-label="Size chart measurements"
      >
        <table>
          <thead>
            <tr>
              <th scope="col">Size</th>
              {shown.map((f) => (
                <th key={f} scope="col">
                  {names[f]} ({unit})
                </th>
              ))}
              <th scope="col">
                <span className="chart-sr">Remove row</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                <td>
                  <input
                    aria-label={`Size label for row ${i + 1}`}
                    value={row.label}
                    maxLength={32}
                    onChange={(e) => edit(i, "label", e.target.value)}
                    disabled={busy}
                  />
                </td>
                {shown.map((f) => (
                  <td key={f}>
                    <input
                      type="number"
                      inputMode="decimal"
                      min="0.001"
                      step="any"
                      aria-label={`${names[f]} for ${row.label || "row " + (i + 1)} in ${unit}`}
                      value={row[f] ?? ""}
                      onChange={(e) => edit(i, f, e.target.value)}
                      disabled={busy}
                    />
                  </td>
                ))}
                <td>
                  <button
                    type="button"
                    aria-label={`Remove size ${row.label || i + 1}`}
                    disabled={busy || rows.length <= 2}
                    onClick={() => removeRow(i)}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        type="button"
        className="secondary"
        disabled={busy || rows.length >= 64}
        onClick={() => setRows((prev) => [...prev, { label: "" }])}
      >
        Add size
      </button>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="chart-actions">
        <button className="primary" disabled={busy}>
          {busy ? "Saving…" : "Use size chart"}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
        {item.sizeChart && (
          <button
            type="button"
            className="chart-remove"
            disabled={busy}
            onClick={() => persist(null)}
          >
            Clear chart
          </button>
        )}
      </div>
    </form>
  );
}
