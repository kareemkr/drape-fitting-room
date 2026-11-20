"use client";
import { useState } from "react";
import { normalizeSizeChart } from "../lib/fitting/garment-size.js";
import { comparableWidths, matchFlatWidth } from "../lib/fitting/match-garment-size.js";
import "./match-garment-size.css";

export default function MatchGarmentSize({ garment, onSizeStepChange, disabled }) {
  const [width, setWidth] = useState("");
  const [area, setArea] = useState("");
  const chart = normalizeSizeChart(garment?.sizeChart, garment?.category);
  if (!chart) return null;
  const fields = comparableWidths(chart, garment.category);
  if (!fields.length) return null;
  const field = fields.includes(area) ? area : fields[0];
  const result = matchFlatWidth(chart, field, width);
  return (
    <details className="match-garment">
      <summary>Compare a garment you own</summary>
      <p>Lay a similar garment that fits you flat. Measure straight across the {field} from edge to edge.</p>
      <div className="match-garment-fields">
        {fields.length > 1 && (
          <label>Compare at
            <select disabled={disabled} value={field} onChange={(event) => { setArea(event.target.value); setWidth(""); }}>
              {fields.map((name) => <option key={name} value={name}>{name[0].toUpperCase() + name.slice(1)}</option>)}
            </select>
          </label>
        )}
        <label>Flat width ({chart.unit})
          <input type="number" min="0.1" step="any" inputMode="decimal" disabled={disabled}
            value={width} onChange={(event) => setWidth(event.target.value)} />
        </label>
      </div>
      {result && (
        <div className="match-garment-result" aria-live="polite">
          <span>{result.outside ? "Outside the chart range. The closest" : "Closest"} flat width is
            {" "}{Number(result.flatWidth.toFixed(2))} {chart.unit} in size {result.label}.</span>
          <button type="button" disabled={disabled} onClick={() => onSizeStepChange(result.step)}>Try {result.label}</button>
        </div>
      )}
    </details>
  );
}
