import { normalizeSizeChart, sizeMeasurementFields } from "./garment-size.js";

const DB_NAME = "drape-fitting-room";
const DB_VERSION = 1;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_EDGE = 1500;

let databasePromise;

function storageError(cause) {
  if (cause?.name === "QuotaExceededError") {
    return new Error(
      "This device is out of storage. Delete a saved item and try again.",
    );
  }
  if (cause?.name === "SecurityError" || cause?.name === "InvalidStateError") {
    return new Error(
      "Device storage is unavailable. Check the browser’s site-storage settings.",
    );
  }
  return new Error(
    "Could not access your saved items on this device. Refresh and try again.",
  );
}

function openDatabase() {
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    let open;
    let blocked = false;
    try {
      open = window.indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(storageError(error));
      return;
    }
    open.onupgradeneeded = () => {
      const db = open.result;
      for (const name of ["garments", "looks"]) {
        if (!db.objectStoreNames.contains(name))
          db.createObjectStore(name, { keyPath: "id" });
      }
    };
    open.onblocked = () => {
      blocked = true;
      reject(
        new Error(
          "Close other Drape tabs, then try accessing your saved items again.",
        ),
      );
    };
    open.onerror = () => reject(storageError(open.error));
    open.onsuccess = () => {
      const db = open.result;
      if (blocked) {
        db.close();
        return;
      }
      db.onversionchange = () => {
        db.close();
        databasePromise = undefined;
      };
      db.onclose = () => {
        databasePromise = undefined;
      };
      resolve(db);
    };
  }).catch((error) => {
    databasePromise = undefined;
    throw error;
  });
  return databasePromise;
}

async function query(storeName, mode, operation) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    try {
      const transaction = db.transaction(storeName, mode);
      const request = operation(transaction.objectStore(storeName));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () =>
        reject(storageError(request.error || transaction.error));
    } catch (error) {
      reject(storageError(error));
    }
  });
}

function createRecord(item, fallbackName) {
  if (
    !item ||
    typeof item.src !== "string" ||
    !/^data:image\/(png|jpeg|webp);base64,/i.test(item.src)
  ) {
    throw new Error("A saved item needs a JPEG, PNG or WebP image.");
  }
  const timestamp = new Date(item.createdAt ?? Date.now());
  return {
    id: item.id || crypto.randomUUID(),
    name: String(item.name || "").trim() || fallbackName,
    src: item.src,
    createdAt: Number.isFinite(timestamp.getTime())
      ? timestamp.toISOString()
      : new Date().toISOString(),
  };
}

async function listNewestFirst(storeName) {
  const records = await query(storeName, "readonly", (store) => store.getAll());
  return records.sort(
    (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
  );
}

export function listGarments() {
  return listNewestFirst("garments");
}
export function listLooks() {
  return listNewestFirst("looks");
}
export function deleteGarment(id) {
  return query("garments", "readwrite", (store) => store.delete(id));
}
export function deleteLook(id) {
  return query("looks", "readwrite", (store) => store.delete(id));
}

export function garmentSizingRecord(item) {
  const record = {};
  if (Array.isArray(item.shopSizes)) {
    const labels = item.shopSizes.slice(0, 64)
      .filter(s => typeof s === "string" && s.trim().length > 0 && s.trim().length <= 48)
      .map(s => s.trim());
    if (labels.length) record.shopSizes = [...new Set(labels)];
  }
  const active = normalizeSizeChart(item.sizeChart, item.category);
  if (active) record.sizeChart = active;
  else if (item.sizeChart !== null) {
    const draft = item.chartDraft ?? item.sizeChart;
    if (draft && ["cm", "in"].includes(draft.unit) && Array.isArray(draft.sizes)) {
      const sizes = [];
      for (const raw of draft.sizes.slice(0, 64)) {
        if (typeof raw?.label !== "string" || !raw.label.trim() || raw.label.length > 48) continue;
        const row = { label: raw.label.trim() };
        for (const field of sizeMeasurementFields("dress")) {
          const v = Number(raw[field]);
          if (Number.isFinite(v) && v > 0 && v <= 400) row[field] = v;
        }
        if (Object.keys(row).length > 1) sizes.push(row);
      }
      if (sizes.length >= 2) record.chartDraft = { unit: draft.unit, reference: "", sizes };
    }
  }
  return record;
}

export async function putGarment(item) {
  const record = {
    ...createRecord(item, "Untitled garment"),
    ...garmentSizingRecord(item),
    brand: String(item.brand || "").trim(),
    category: String(item.category || "top"),
  };
  await query("garments", "readwrite", (store) => store.put(record));
  return record;
}

export async function putLook(item) {
  const record = createRecord(item, "Untitled look");
  const size = item.sizing;
  if (size && Number.isInteger(size.sizeStep) && ["relative", "chart"].includes(size.sizeMode)
      && typeof size.sizeLabel === "string" && size.sizeLabel.length <= 48) {
    record.sizing = { sizeStep: size.sizeStep, sizeMode: size.sizeMode, sizeLabel: size.sizeLabel };
  }
  await query("looks", "readwrite", (store) => store.put(record));
  return record;
}

async function imageType(blob) {
  const bytes = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte))
    return "image/png";
  const header = String.fromCharCode(...bytes);
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP")
    return "image/webp";
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a"))
    return "image/gif";
  if (header.slice(4, 8) === "ftyp") {
    const boxSize = new DataView(bytes.buffer).getUint32(0);
    const end = Math.min(header.length, boxSize || header.length);
    for (let i = 8; i + 4 <= end; i += 4) {
      if (i !== 12 && ["avif", "avis"].includes(header.slice(i, i + 4)))
        return "image/avif";
    }
  }
  return null;
}

function decodeWithImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () =>
      resolve({ image, close: () => URL.revokeObjectURL(url) });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("This image could not be opened. Try another photo."));
    };
    image.src = url;
  });
}

async function decodeImage(blob) {
  if (typeof createImageBitmap === "function") {
    try {
      const image = await createImageBitmap(blob, {
        imageOrientation: "from-image",
      });
      return { image, close: () => image.close() };
    } catch {
      // The image element supports additional browser JPEG decoders.
    }
  }
  return decodeWithImage(blob);
}

export async function prepareImage(file, { imported = false } = {}) {
  if (!(file instanceof Blob) || file.size === 0)
    throw new Error("Choose an image file to continue.");
  if (file.size > MAX_FILE_BYTES)
    throw new Error("Choose an image smaller than 10 MB.");
  const type = await imageType(file);
  if (!type || (!imported && (type === "image/avif" || type === "image/gif"))) {
    throw new Error(
      imported
        ? "The shop image format is unsupported. Upload a JPEG, PNG or WebP product photo."
        : "Choose a JPEG, PNG or WebP image.",
    );
  }
  const blob = file.type === type ? file : file.slice(0, file.size, type);
  const { image, close } = await decodeImage(blob);
  try {
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height)
      throw new Error("This image could not be opened. Try another photo.");
    const ratio = Math.min(1, MAX_IMAGE_EDGE / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser could not prepare the photo.");
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const result = canvas.toDataURL("image/webp", 0.92);
    if (!result.startsWith("data:image/"))
      throw new Error("This image is too large to process on this device.");
    return result;
  } finally {
    close();
  }
}

async function readImageResponse(response) {
  if (Number(response.headers.get("Content-Length")) > MAX_FILE_BYTES) {
    throw new Error(
      "The product image is over 10 MB. Upload a smaller version.",
    );
  }
  if (!response.body?.getReader) return response.blob();
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_FILE_BYTES) {
        await reader.cancel();
        throw new Error(
          "The product image is over 10 MB. Upload a smaller version.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new Blob(chunks, { type: response.headers.get("Content-Type") || "" });
}

export async function fetchImageAsDataURL(url) {
  const source = new URL(url, window.location.href);
  if (!["http:", "https:", "blob:", "data:"].includes(source.protocol)) {
    throw new Error("Choose a valid product image URL.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 18000);
  let blob;
  try {
    const response = await fetch(source, {
      signal: controller.signal,
      credentials: "same-origin",
    });
    if (!response.ok)
      throw new Error(
        "The product photo could not be loaded. Upload a garment image instead.",
      );
    blob = await readImageResponse(response);
  } catch (error) {
    if (error.name === "AbortError")
      throw new Error(
        "The product image took too long to load. Try again or upload an image.",
      );
    if (error instanceof TypeError)
      throw new Error(
        "The product photo could not be loaded. Upload a garment image instead.",
      );
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  return prepareImage(blob, { imported: true });
}
