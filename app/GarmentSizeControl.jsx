"use client";

import { useMemo } from "react";
import { Minus, Plus, RotateCcw } from "lucide-react";
import { getGarmentSize } from "../lib/fitting/garment-size.js";
import MatchGarmentSize from "./MatchGarmentSize.jsx";
import "./garment-size.css";

export function GarmentSizeControl({
  garment,
  sizeStep = 0,
  onSizeStepChange,
  onEditSizeChart,
  disabled = false,
}) {
  const size = useMemo(() => getGarmentSize(garment, sizeStep), [garment, sizeStep]);
  if (!garment || !onSizeStepChange) return null;
  const chart = size.mode === "chart";
  const note = chart
    ? size.limitedDimensions.length
      ? "The preview limits unusually large changes in the size chart."
      : size.estimatedDimensions.length && size.step !== 0
        ? "Uses garment measurements from the chart. Unlisted dimensions are estimated."
        : "Uses garment measurements from the size chart."
    : "Visual estimate. If your original clothes show at the sides, try one size up.";
  return (
    <section className="garment-size" aria-label="Garment size">
      <div className="garment-size-heading">
        <strong>Garment size</strong>
        {size.step !== 0 && (
          <button
            type="button"
            className="garment-size-reset"
            aria-label="Reset to reference size"
            disabled={disabled}
            onClick={() => onSizeStepChange(0)}
          >
            <RotateCcw size={14} aria-hidden="true" /> Reset
          </button>
        )}
      </div>
      <div className="garment-size-steps">
        <button
          type="button"
          className="garment-size-step"
          aria-label="One size down"
          disabled={disabled || size.step <= size.minStep}
          onClick={() => onSizeStepChange(size.step - 1)}
        >
          <Minus size={16} aria-hidden="true" /> Size down
        </button>
        <output aria-label="Selected garment size" aria-live="polite" aria-atomic="true">
          {size.label}
        </output>
        <button
          type="button"
          className="garment-size-step"
          aria-label="One size up"
          disabled={disabled || size.step >= size.maxStep}
          onClick={() => onSizeStepChange(size.step + 1)}
        >
          <Plus size={16} aria-hidden="true" /> Size up
        </button>
      </div>
      <div className="garment-size-note">
        <p>{note}</p>
        {onEditSizeChart && (
          <button
            type="button"
            disabled={disabled}
            onClick={onEditSizeChart}
          >
            {chart ? "Edit size chart" : "Add size chart"}
          </button>
        )}
      </div>
      {chart && (
        <MatchGarmentSize
          key={garment.id || garment.src}
          garment={garment}
          onSizeStepChange={onSizeStepChange}
          disabled={disabled}
        />
      )}
    </section>
  );
}

export default GarmentSizeControl;
