"use client";
import { useEffect, useRef, useState } from "react";
import {
  Check,
  Expand,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { renderFitting } from "../lib/fitting/fitting.js";
import { categoryLabels, initialFit } from "./catalog.js";
export function Brand() {
  return (
    <span className="brand">
      <img src="/favicon.svg" alt="" />
      <b>
        drape<span>.</span>
      </b>
    </span>
  );
}
export function Dialog({ title, children, onClose, wide = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    const active = document.activeElement;
    el.showModal();
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = old;
      el.close();
      active?.focus?.();
    };
  }, []);
  return (
    <dialog
      className={"dialog " + (wide ? "wide" : "")}
      ref={ref}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) {
          const b = ref.current.getBoundingClientRect();
          if (
            e.clientX < b.left ||
            e.clientX > b.right ||
            e.clientY < b.top ||
            e.clientY > b.bottom
          )
            onClose();
        }
      }}
    >
      <div className="dialog-head">
        <h2>{title}</h2>
        <button
          aria-label="Close dialog"
          onClick={onClose}
          className="icon-btn"
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Tile({ item, selected, onSelect, onRemove }) {
  return (
    <article className={"tile " + (selected ? "chosen" : "")}>
      <button
        className="tile-action"
        onClick={() => onSelect(item)}
        aria-label={"Try on " + item.name}
        aria-pressed={selected}
      >
        <div
          className="tile-photo"
          style={{ background: item.tone || "#eae7ef" }}
        >
          <img src={item.src} alt="" loading="lazy" />
          {selected && (
            <span className="selected-mark">
              <Check size={13} strokeWidth={3} />
            </span>
          )}
        </div>
        <div className="tile-copy">
          <strong>{item.name}</strong>
          <span>
            {item.label || categoryLabels[item.category] || "Garment"}
          </span>
        </div>
      </button>
      {onRemove && (
        <button
          className="tile-delete icon-btn"
          aria-label={"Remove " + item.name}
          onClick={() => onRemove(item)}
        >
          <Trash2 size={15} />
        </button>
      )}
    </article>
  );
}
export function StudioMirror({
  person,
  item,
  original,
  setOriginal,
  fit,
  aiResult,
  aiLabel,
  sizingControls,
  guide,
  landmarks,
  modelName,
  calibrated,
  onAdjust,
  onExpand,
  canvasRef,
  onReady,
  onError,
}) {
  const edges = useRef(null);
  const [spinner, setSpinner] = useState(false);
  const [renderState, setRenderState] = useState({
    alignment: "photo",
    pending: false,
  });
  const source = original ? person : aiResult || person;
  const layer = original || aiResult ? null : item.src;
  const alternate = original
    ? "Original photo"
    : aiResult
      ? aiLabel || "AI try-on"
      : renderState.pending
        ? "Aligning to body…"
        : calibrated
          ? "Custom alignment"
          : renderState.alignment === "estimated"
            ? "Estimated waist"
            : "Fit guide";
  useEffect(() => {
    let live = true;
    const canvas = canvasRef.current;
    if (!canvas) return;
    onReady(false);
    setSpinner(true);
    const render = () =>
      renderFitting(canvas, {
        person: source,
        garment: layer,
        category: item.category,
        ...fit,
        onRefined: painted,
        garmentId: item.studio ? item.id : undefined,
        garmentName: item.name,
        garmentStudio: item.studio,
        landmarks,
      });
    const painted = (result) => {
      if (!live || !result.rendered) return;
      setRenderState({
        alignment: result.alignment,
        pending: !!result.pendingAlignment,
      });
      const edge = edges.current;
      if (edge) {
        edge.width = 2;
        edge.height = 20;
        const e = edge.getContext("2d");
        e.imageSmoothingEnabled = true;
        e.imageSmoothingQuality = "high";
        e.drawImage(canvas, 0, 0, 20, canvas.height, 0, 0, 1, 20);
        e.drawImage(
          canvas,
          canvas.width - 20,
          0,
          20,
          canvas.height,
          1,
          0,
          1,
          20,
        );
      }
      onReady(true, result);
      setSpinner(false);
    };
    render()
      .then(painted)
      .catch((e) => {
        if (live) {
          setSpinner(false);
          onReady(false);
          onError(e.message);
        }
      });
    return () => {
      live = false;
    };
  }, [
    source,
    layer,
    fit,
    item,
    person,
    landmarks,
    canvasRef,
    onReady,
    onError,
  ]);
  return (
    <section className="mirror" aria-label="Outfit preview">
      <div className="photo-stage">
        <canvas ref={edges} className="edge-extension" aria-hidden="true" />
        {modelName && (
          <div
            className="portrait-fallback"
            style={{ backgroundImage: 'url("' + person + '")' }}
          />
        )}
        <canvas
          ref={canvasRef}
          className="portrait"
          aria-label={
            original
              ? "Original photo of " + (modelName || "your model")
              : alternate + " of " + item.name
          }
        />
        <div className="stage-top">
          <span className="preview-tag">
            <i />
            {alternate}
          </span>
          <button
            className="glass-btn"
            onClick={onExpand}
            aria-label="Expand preview"
          >
            <Expand size={16} />
          </button>
        </div>
        <div className="stage-credit">
          <span className="credit-line" />
          {original ? modelName || "Your photo" : item.name}
        </div>
        {spinner && (
          <span className="loading-dot" aria-label="Updating preview" />
        )}
      </div>
      <div className="mirror-bar">
        <div className="mode-switch" aria-label="Preview mode">
          <button
            onClick={() => setOriginal(true)}
            aria-pressed={original}
            className={original ? "on" : ""}
          >
            Original
          </button>
          <button
            onClick={() => setOriginal(false)}
            aria-pressed={!original}
            className={!original ? "on" : ""}
          >
            <Sparkles size={13} />
            {guide || !aiResult ? "Local fit" : "AI try-on"}
          </button>
        </div>
        <button className="adjust-link" onClick={onAdjust}>
          <SlidersHorizontal size={15} /> {guide ? "Adjust fit" : "Fit guide"}
        </button>
      </div>
      {sizingControls}
    </section>
  );
}
export function FitForm({
  fit,
  onChange,
  onClose,
  item,
  changeCategory,
  onAlign,
  onAuto,
  refined,
  sleeved,
  customized,
}) {
  const dimensions = {
    shoulderScale: ["Shoulders", 0.75, 1.35, 0.01],
    torsoScale: ["Body width", 0.7, 1.45, 0.01],
    lengthScale: ["Hem length", 0.7, 1.35, 0.01],
    ...(sleeved ? { sleeveScale: ["Sleeve length", 0.65, 1.4, 0.01] } : {}),
  };
  const transforms = {
    scale: ["Overall size", 0.25, 2.7, 0.01],
    dx: ["Horizontal", -0.65, 0.65, 0.005],
    dy: ["Vertical", -0.65, 0.65, 0.005],
    rotation: ["Rotation", -90, 90, 1],
  };
  const slider = ([key, [label, min, max, step]]) => (
    <label key={key} className="slider-label">
      <span>
        {label}
        <output>
          {key === "rotation"
            ? Math.round(fit[key]) + "°"
            : Math.round(fit[key] * 100) + "%"}
        </output>
      </span>
      <input
        aria-label={label}
        type="range"
        min={min}
        max={max}
        step={step}
        value={fit[key]}
        onChange={(e) => onChange({ ...fit, [key]: Number(e.target.value) })}
      />
    </label>
  );
  return (
    <>
      <div className="alignment-tools">
        <button className="secondary" onClick={onAlign}>
          {customized ? "Edit body points" : "Mark body points"}
        </button>
        {onAuto && (
          <button className="text-link" onClick={onAuto}>
            Use automatic fit
          </button>
        )}
      </div>
      <label className="field-label">
        Garment type
        <select
          value={item.category}
          onChange={(e) => changeCategory(e.target.value)}
        >
          {Object.entries(categoryLabels).map(([v, n]) => (
            <option key={v} value={v}>
              {n}
            </option>
          ))}
        </select>
      </label>
      {refined && (
        <div className="proportions-group">
          {Object.entries(dimensions).map(slider)}
        </div>
      )}
      {refined ? (
        <details className="position-settings">
          <summary>Size and position</summary>
          {Object.entries(transforms).map(slider)}
        </details>
      ) : (
        Object.entries(transforms).map(slider)
      )}
      <label className="check-label">
        <input
          type="checkbox"
          checked={fit.removeBackground}
          onChange={(e) =>
            onChange({ ...fit, removeBackground: e.target.checked })
          }
        />
        Remove plain product background
      </label>
      <div className="dialog-actions">
        <button
          className="secondary"
          onClick={() => onChange({ ...initialFit })}
        >
          Reset
        </button>
        <button className="primary" onClick={onClose}>
          Done
        </button>
      </div>
    </>
  );
}
