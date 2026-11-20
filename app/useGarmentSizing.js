"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { getGarmentSize, normalizeSizeChart } from "../lib/fitting/garment-size.js";

const eventName = "drape-size-changed";
const memory = new Map();
const serverSnapshot = () => "";

function read(key) {
  if (memory.has(key)) return memory.get(key);
  try { return window.localStorage.getItem(key) ?? ""; } catch { return ""; }
}

function write(key, value) {
  const raw = JSON.stringify(value);
  try {
    window.localStorage.setItem(key, raw);
    memory.delete(key);
  } catch {
    memory.set(key, raw);
  }
  window.dispatchEvent(new CustomEvent(eventName, { detail: key }));
}

function useSetting(key) {
  const subscribe = useCallback((change) => {
    const storage = (event) => {
      if (event.key === key || event.key === null) { memory.delete(key); change(); }
    };
    const local = (event) => { if (event.detail === key) change(); };
    window.addEventListener("storage", storage);
    window.addEventListener(eventName, local);
    return () => {
      window.removeEventListener("storage", storage);
      window.removeEventListener(eventName, local);
    };
  }, [key]);
  const raw = useSyncExternalStore(subscribe, useCallback(() => read(key), [key]), serverSnapshot);
  return useMemo(() => {
    try { return raw ? JSON.parse(raw) : undefined; } catch { return undefined; }
  }, [raw]);
}

export function useGarmentSizing(rawItem) {
  const prefix = "drape-fit-v1:" + rawItem.id + ":";
  const customChart = useSetting(prefix + "chart");
  const selection = useSetting(prefix + "selection");
  const item = useMemo(() => customChart === undefined ? rawItem :
    { ...rawItem, sizeChart: normalizeSizeChart(customChart, rawItem.category) }, [rawItem, customChart]);
  const size = useMemo(() => {
    const chart = normalizeSizeChart(item.sizeChart, item.category);
    if (chart && selection?.mode === "chart") {
      const index = chart.sizes.findIndex((row) => row.label === selection.label);
      if (index >= 0) return getGarmentSize(item, index - chart.sizes.findIndex((row) => row.label === chart.reference));
    }
    return getGarmentSize(item, !chart && selection?.mode === "relative" ? selection.step : 0);
  }, [item, selection]);
  function selectSize(step) {
    const next = getGarmentSize(item, step);
    write(prefix + "selection", { step: next.step, mode: next.mode, label: next.label });
  }
  function storeCustomChart(chart) {
    write(prefix + "chart", chart);
    write(prefix + "selection", null);
  }
  function resetSelection() { write(prefix + "selection", null); }
  return { item, size, selectSize, storeCustomChart, resetSelection };
}
