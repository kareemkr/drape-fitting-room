import {
  buildUpperMesh,
  drawUpperMesh,
  restoreUpperHands,
} from "./upper-warp.js";
import { NEUTRAL_SIZE_GRADE } from "./garment-size.js";
import { getGarmentAnatomy } from "./garment-anatomy.js";
import { garmentProduct } from "./garment-product.js";
import { createLiveGarmentRenderer } from "./garment-renderer.js";
import { deriveLiveWaist, estimatePhotoWaist } from "./live-waist.js";
import { measureBodyOutline } from "./body-outline.js";
import { createLiveOutline } from "./live-outline.js";
import { detectBodyPose, fitLandmarks, getCachedPose } from "./pose.js";

// Source images and fits stay in the browser. Landmarks are normalized to the original photo frame.
const imageCache = new Map();
const garmentCache = new Map();
const faceCache = new Map();
const calibratedOutlines = new WeakMap();
const photoGarmentLayers = new WeakMap();
const renderVersions = new WeakMap();
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const finite = (value, fallback) => (Number.isFinite(value) ? value : fallback);
const FALLBACK = { cx: 0.5, neckY: 0.305, shoulderWidth: 0.48, waistY: 0.76 };

function remember(cache, key, create, capacity) {
  if (cache.has(key)) {
    const result = cache.get(key);
    cache.delete(key);
    cache.set(key, result);
    return result;
  }
  const result = Promise.resolve().then(create);
  cache.set(key, result);
  if (cache.size > capacity) cache.delete(cache.keys().next().value);
  result.catch(() => {
    if (cache.get(key) === result) cache.delete(key);
  });
  return result;
}

function loadImage(source) {
  return remember(
    imageCache,
    source,
    () =>
      new Promise((resolve, reject) => {
        const url = new URL(source, location.href);
        const localUrl =
          url.origin === location.origin &&
          ["http:", "https:", "blob:", "file:"].includes(url.protocol);
        const safeData =
          /^data:image\/(?:png|jpe?g|webp|avif|gif|bmp)(?:;|,)/i.test(source);
        if (!localUrl && !safeData) {
          reject(
            new Error(
              "Open the product link through Import, or upload the image.",
            ),
          );
          return;
        }
        const image = new Image();
        image.decoding = "async";
        image.onload = () => {
          if (image.naturalWidth > 0 && image.naturalHeight > 0) resolve(image);
          else reject(new Error("The image has no usable dimensions."));
        };
        image.onerror = () =>
          reject(
            new Error(
              "This photo could not be opened. Try a JPG, PNG or WebP image.",
            ),
          );
        image.src = url.href;
      }),
    8,
  );
}

function surface(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function colorDistance(r, g, b, color) {
  const dr = r - color[0],
    dg = g - color[1],
    db = b - color[2];
  // The chroma term helps preserve a pale colored garment against a light grey background.
  return Math.max(
    Math.abs(dr),
    Math.abs(dg),
    Math.abs(db),
    Math.abs(dr - db) * 1.25,
    Math.abs(dg - db),
  );
}

function findBackdrop(pixels, width, height) {
  const samples = [];
  function sample(x, y) {
    const offset = (y * width + x) * 4;
    if (pixels[offset + 3] < 210) return;
    samples.push([pixels[offset], pixels[offset + 1], pixels[offset + 2]]);
  }
  const insetX = Math.min(width - 1, Math.floor(width * 0.012));
  const insetY = Math.min(height - 1, Math.floor(height * 0.012));
  const step = 32;
  for (let i = 0; i <= step; i++) {
    const x = Math.round(((width - 1) * i) / step);
    const y = Math.round(((height - 1) * i) / step);
    sample(x, insetY);
    sample(x, height - 1 - insetY);
    sample(insetX, y);
    sample(width - 1 - insetX, y);
  }
  if (samples.length < 12) return null;
  let best = [];
  for (const color of samples) {
    const neighbors = samples.filter((c) => colorDistance(...c, color) < 22);
    if (neighbors.length > best.length) best = neighbors;
  }
  // Leave a textured backdrop in place when its edge does not describe a single background.
  if (best.length < samples.length * 0.58) return null;
  const center = [0, 1, 2].map((channel) => {
    const values = best.map((c) => c[channel]).sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  });
  const spread = best
    .map((c) => colorDistance(...c, center))
    .sort((a, b) => a - b);
  const variation = spread[Math.floor(spread.length * 0.9)];
  return { center, tolerance: clamp(8 + 1.75 * variation, 10, 37) };
}

function cutBackground(frame) {
  const { data, width, height } = frame;
  const count = width * height;
  let transparency = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] <= 20) transparency++;
  if (transparency > count * 0.03) return "transparent";
  const backdrop = findBackdrop(data, width, height);
  if (!backdrop) return "unchanged";
  const { center, tolerance } = backdrop;
  const state = new Uint8Array(count);
  const queue = new Uint32Array(count);
  let front = 0,
    end = 0;

  function consider(index) {
    if (state[index]) return;
    const offset = index * 4;
    state[index] = 1;
    if (
      data[offset + 3] > 20 &&
      colorDistance(data[offset], data[offset + 1], data[offset + 2], center) >
        tolerance
    )
      return;
    state[index] = 2;
    queue[end++] = index;
  }
  for (let x = 0; x < width; x++) {
    consider(x);
    consider((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y++) {
    consider(y * width);
    consider(y * width + width - 1);
  }
  while (front < end) {
    const index = queue[front++],
      x = index % width;
    if (x > 0) consider(index - 1);
    if (x < width - 1) consider(index + 1);
    if (index >= width) consider(index - width);
    if (index + width < count) consider(index + width);
  }
  // A nearly blank or very low-contrast photo is safer intact than erased.
  if (end < count * 0.025 || end > count * 0.965) return "unchanged";
  for (let i = 0; i < end; i++) data[queue[i] * 4 + 3] = 0;
  // Feather just the transition pixels touching removed background, keeping pale interior detail.
  for (let index = 0; index < count; index++) {
    if (state[index] !== 1) continue;
    const pos = index * 4;
    const distance = colorDistance(
      data[pos],
      data[pos + 1],
      data[pos + 2],
      center,
    );
    const opacity = clamp((distance - tolerance) / 11, 0.2, 1);
    if (opacity < 1) data[pos + 3] = Math.round(data[pos + 3] * opacity);
  }
  return "removed";
}

function alphaBounds(frame) {
  const { data, width, height } = frame;
  let left = width,
    right = -1,
    top = height,
    bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] < 40) continue;
      left = Math.min(x, left);
      right = Math.max(x, right);
      top = Math.min(y, top);
      bottom = y;
    }
  }
  if (right < left || bottom < top)
    throw new Error("This garment image appears to be empty.");
  left = Math.max(0, left - 1);
  top = Math.max(0, top - 1);
  right = Math.min(width - 1, right + 1);
  bottom = Math.min(height - 1, bottom + 1);
  return [left, top, right - left + 1, bottom - top + 1];
}

export function prepareGarment(source, removeBackground, garmentId, upper) {
  return remember(
    garmentCache,
    (removeBackground ? "cut:" : "raw:") +
      (upper ? "upper:" : "other:") +
      (garmentId || "") +
      source,
    async () => {
      const image = await loadImage(source);
      const factor = Math.min(
        1,
        1024 / Math.max(image.naturalWidth, image.naturalHeight),
      );
      const canvas = surface(
        Math.max(1, Math.round(image.naturalWidth * factor)),
        Math.max(1, Math.round(image.naturalHeight * factor)),
      );
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const background = removeBackground ? cutBackground(frame) : "original";
      if (background === "removed") ctx.putImageData(frame, 0, 0);
      const bounds = alphaBounds(frame);
      const anatomy = upper
        ? getGarmentAnatomy(canvas, bounds, { id: garmentId })
        : null;
      return { canvas, bounds, background, anatomy };
    },
    7,
  );
}

function facePosition(source, image) {
  if (typeof globalThis.FaceDetector !== "function") return null;
  return remember(
    faceCache,
    source,
    async () => {
      let timeout;
      try {
        const detect = new globalThis.FaceDetector({
          fastMode: true,
          maxDetectedFaces: 2,
        }).detect(image);
        const faces = await Promise.race([
          detect,
          new Promise((resolve) => {
            timeout = setTimeout(() => resolve([]), 650);
          }),
        ]);
        if (faces.length !== 1) return null;
        return faces[0].boundingBox;
      } catch {
        return null;
      } finally {
        clearTimeout(timeout);
      }
    },
    6,
  );
}

function chooseAnchors(face, photo, target, override) {
  if (override) return { ...FALLBACK, ...override };
  if (!face) return FALLBACK;
  const { factor, left, top } = photo;
  const { width, height } = target;
  const faceHeight = (face.height * factor) / height;
  const cx = (left + factor * (face.x + face.width / 2)) / width;
  const chin = (top + factor * (face.y + face.height)) / height;
  if (
    faceHeight < 0.044 ||
    faceHeight > 0.32 ||
    cx < 0.1 ||
    cx > 0.9 ||
    chin > 0.64
  )
    return FALLBACK;
  return {
    cx,
    neckY: chin + faceHeight * 0.17,
    shoulderWidth: clamp(((face.width * factor) / width) * 2.88, 0.17, 0.95),
    waistY: chin + faceHeight * 2.65,
  };
}

function garmentPosition(
  bounds,
  category,
  anchors,
  width,
  height,
  placement = {},
) {
  const ratio = bounds[2] / bounds[3];
  const name = String(category).toLowerCase();
  const isBottom = /bottom|trouser|pant|short|skirt|jean/.test(name);
  const isDress = /dress|full|jumpsuit/.test(name);
  const torso = anchors.waistY - anchors.neckY;
  const top = isBottom ? anchors.waistY - 0.02 : anchors.neckY - 0.09 * torso;
  // On a front-on product photo, long sleeves extend from the collar down past the hips.
  const targetHeight = height * torso * (isBottom ? 1.8 : isDress ? 2.15 : 1.6);
  const targetWidth =
    width * anchors.shoulderWidth * (isBottom ? 0.99 : isDress ? 1.3 : 1.38);
  // Product cutouts can be very wide (extended sleeves) or unusually long. Bound both axes.
  const fitWidth = Math.min(targetWidth, targetHeight * ratio * 1.13);
  const fitHeight = Math.min(targetHeight, (fitWidth / ratio) * 1.18);
  return {
    cx: finite(placement.x, anchors.cx) * width,
    top: finite(placement.y, top) * height,
    width: finite(placement.width, fitWidth / width) * width,
    height: finite(placement.height, fitHeight / height) * height,
  };
}

// Export at the source aspect ratio: the camera frame and landmark coordinates stay identical.
function originalPhotoFrame(image, targetWidth) {
  const factor = Math.min(
    targetWidth / image.naturalWidth,
    (targetWidth * 1.6) / image.naturalHeight,
  );
  return {
    width: Math.max(1, Math.round(image.naturalWidth * factor)),
    height: Math.max(1, Math.round(image.naturalHeight * factor)),
  };
}
function calibratedPoints(points, base) {
  const cached = calibratedOutlines.get(points);
  if (cached?.base === base) return cached.measured;
  let outline = points.outline;
  if (!outline) {
    const factor = Math.min(1, 520 / Math.max(base.naturalWidth, base.naturalHeight));
    const photo = surface(
      Math.max(1, Math.round(base.naturalWidth * factor)),
      Math.max(1, Math.round(base.naturalHeight * factor)),
    );
    photo.getContext("2d", { willReadFrequently: true })
      .drawImage(base, 0, 0, photo.width, photo.height);
    outline = measureBodyOutline({
      points, canvas: photo, imageWidth: photo.width, imageHeight: photo.height,
    });
  }
  // Retain segmentation-backed torso widths. A bent forearm can still expose
  // its outside edge to the background while the shirt hides its inside edge.
  const exterior = createLiveOutline().sample(points, base).outline;
  if (exterior) {
    outline = { ...outline };
    for (const side of ["left", "right"]) {
      const values = { ...outline[side] };
      for (const key of ["outerForearm", "outerWrist"]) {
        if (Number.isFinite(exterior[side]?.[key])) values[key] = exterior[side][key];
      }
      outline[side] = values;
    }
  }
  const measured = Object.assign(points.slice(), { outline, backend: points.backend });
  calibratedOutlines.set(points, { base, measured });
  return measured;
}

function drawPhotoGarment(ctx, raw, points, base, fit) {
  const { canvas } = ctx;
  const top = fit.category === "top";
  const measured = top ? deriveLiveWaist(points, canvas) : null;
  const support = top ? measured ?? estimatePhotoWaist(points, canvas) : null;
  if (top && !support) return null;
  const product = garmentProduct(raw, {
    category: fit.category,
    name: fit.garmentName,
    studio: fit.garmentStudio === true,
  });
  if (product.portrait) return null;
  let entry = photoGarmentLayers.get(canvas);
  if (!entry) {
    const layer = surface(canvas.width, canvas.height);
    entry = {
      layer,
      renderer: createLiveGarmentRenderer(layer, { still: true }),
    };
    photoGarmentLayers.set(canvas, entry);
  }
  if (entry.layer.width !== canvas.width) entry.layer.width = canvas.width;
  if (entry.layer.height !== canvas.height) entry.layer.height = canvas.height;
  // The mask cuts holes in the garment layer so foreground fingers reveal
  // the untouched photo underneath, including after a fit slider moves the shirt.
  const drawn = entry.renderer.draw(product, points, {
    frame: base,
    exact: true,
    fit,
    sizeGrade: fit.sizeGrade,
    waistProfile: support,
  });
  if (!drawn) return null;
  ctx.drawImage(entry.layer, 0, 0);
  return {
    sleeveLength: product.sleeveLength,
    alignment: top ? (measured ? "mesh" : "estimated") : "pose",
  };
}

// With only a manual placement box, there is no observed arm or leg to follow.
// Grade horizontal product sections about their original center and keep the
// top of the box fixed. Calibrated widths, offsets and rotations still apply.
function drawBoxGarment(ctx, raw, width, height, category, name, grade) {
  if (!grade || Object.values(grade).every((factor) => factor === 1)) {
    ctx.drawImage(raw.canvas, ...raw.bounds, -width / 2, -height / 2, width, height);
    return;
  }
  const top = category === "top";
  const bottom = category === "bottom";
  const trousers = /trousers?|pants?|jeans|shorts|leggings|jumpsuit|romper|culottes/i.test(name || "");
  const fork = bottom ? 0.27 : 0.6;
  const riseDelta = clamp((grade.length - 1) - (1 - fork) * (grade.legLength - 1), -0.65 * fork, fork);
  const sections = bottom
    ? [[0, grade.waist], [0.2, grade.hip], [0.5, grade.legWidth], [1, grade.legWidth]]
    : [[0, grade.shoulder], [top ? 0.33 : 0.21, grade.chest],
       [top ? 0.7 : 0.39, grade.waist], [top ? 1 : 0.55, grade.hip]];
  if (!bottom && !top) sections.push([1, grade.legWidth]);
  const vertices = [];
  const triangles = [];
  for (const [y, widthGrade] of sections) {
    const gradedY = trousers
      ? y + Math.min(1, y / fork) * riseDelta + Math.max(0, y - fork) * (grade.legLength - 1)
      : y * grade.length;
    const i = vertices.length;
    for (const x of [0, 1]) {
      vertices.push({
        s: { x, y },
        t: { x: (x - 0.5) * width * widthGrade, y: (gradedY - 0.5) * height },
      });
    }
    if (i) triangles.push([i - 2, i - 1, i], [i - 1, i + 1, i]);
  }
  drawUpperMesh(ctx, raw.canvas, raw.bounds, { vertices, triangles });
}

export async function renderFitting(canvas, options = {}) {
  if (!canvas || typeof canvas.getContext !== "function")
    throw new Error("A preview canvas is required.");
  const version = (renderVersions.get(canvas) || 0) + 1;
  renderVersions.set(canvas, version);
  const {
    person,
    garment,
    category = "top",
    removeBackground = true,
    anchors,
    placement,
    scale = 1,
    dx = 0,
    dy = 0,
    rotation = 0,
    faceDetection = true,
    outputWidth = 960,
  } = options;
  if (!person) throw new Error("Choose a model photo first.");
  let base, product, face;
  try {
    [base, product] = await Promise.all([
      loadImage(person),
      garment
        ? prepareGarment(
            garment,
            removeBackground,
            options.garmentId,
            category === "top",
          )
        : null,
    ]);
    if (
      product &&
      !options.landmarks &&
      !anchors &&
      !placement &&
      faceDetection
    )
      face = await facePosition(person, base);
  } catch (error) {
    if (renderVersions.get(canvas) !== version) return { rendered: false };
    throw error;
  }
  if (renderVersions.get(canvas) !== version) return { rendered: false };
  const canDetect =
    product &&
    !anchors &&
    !placement &&
    options.poseDetection !== false &&
    /^(data:|blob:)/.test(person);
  const landmarks =
    options.landmarks || (canDetect ? getCachedPose(person) : null);
  const { width, height } = originalPhotoFrame(
    base,
    clamp(finite(outputWidth, 960), 160, 1920),
  );
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext("2d");
  const background = product?.background ?? null;
  function paint(points) {
    let alignment = product ? "manual" : "photo";
    let sleeveLength = product?.anatomy?.sleeveLength;
    ctx.save();
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = "#e9e9e6";
      ctx.fillRect(0, 0, width, height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      const photo = { left: 0, top: 0, width, height };
      const factor = width / base.naturalWidth;
      ctx.drawImage(base, 0, 0, width, height);
      let prepared = product && !placement && !anchors ? points : null;
      if (category === "top" && prepared) prepared = calibratedPoints(prepared, base);
      const fitted =
        prepared &&
        (background === "transparent" || background === "removed")
          ? drawPhotoGarment(ctx, product, prepared, base, {
              ...options,
              category,
              scale: clamp(finite(scale, 1), 0.12, 4),
              dx: finite(dx, 0),
              dy: finite(dy, 0),
              rotation: finite(rotation, 0),
            })
          : null;
      const grade = options.sizeGrade ?? NEUTRAL_SIZE_GRADE;
      const mesh =
        !fitted && category === "top" && product?.anatomy && prepared
          ? buildUpperMesh(prepared, photo, product.anatomy, {
              ...options,
              shoulderScale: finite(options.shoulderScale, 1) * grade.shoulder,
              torsoScale: finite(options.torsoScale, 1) * (grade.chest + grade.waist) / 2,
              lengthScale: finite(options.lengthScale, 1) * grade.length,
              sleeveScale: finite(options.sleeveScale, 1) * grade.sleeveLength,
              garmentRatio: product.bounds[2] / product.bounds[3],
            })
          : null;
      if (fitted) {
        sleeveLength = fitted.sleeveLength;
        alignment = fitted.alignment;
      } else if (mesh) {
        ctx.save();
        ctx.translate(
          mesh.cx + width * finite(dx, 0),
          mesh.cy + height * finite(dy, 0),
        );
        ctx.rotate((finite(rotation, 0) * Math.PI) / 180);
        const zoom = clamp(finite(scale, 1), 0.12, 4);
        ctx.scale(zoom, zoom);
        ctx.translate(-mesh.cx, -mesh.cy);
        drawUpperMesh(ctx, product.canvas, product.bounds, mesh);
        ctx.restore();
        restoreUpperHands(ctx, base, photo, prepared, mesh);
        alignment = "mesh";
      } else if (product) {
        const body = chooseAnchors(
          face,
          { factor, left: 0, top: 0 },
          { width, height },
          anchors,
        );
        const measured =
          points && !anchors && !placement
            ? fitLandmarks(
                points,
                photo,
                category,
                product.bounds[2] / product.bounds[3],
              )
            : null;
        const box =
          measured ||
          garmentPosition(
            product.bounds,
            category,
            body,
            width,
            height,
            placement,
          );
        alignment = measured
          ? "pose"
          : placement || anchors
            ? "calibrated"
            : face
              ? "face"
              : "manual";
        const zoom = clamp(finite(scale, 1), 0.12, 4);
        const gw = zoom * box.width,
          gh = zoom * box.height;
        ctx.translate(
          box.cx + width * finite(dx, 0),
          box.top + gh / 2 + height * finite(dy, 0),
        );
        ctx.rotate(((finite(rotation, 0) + (box.tilt || 0)) * Math.PI) / 180);
        if (box.lean) ctx.transform(1, 0, box.lean, 1, (box.lean * gh) / 2, 0);
        drawBoxGarment(ctx, product, gw, gh, category, options.garmentName, options.sizeGrade);
      }
    } finally {
      ctx.restore();
    }
    return {
      rendered: true,
      background,
      alignment,
      sleeveLength,
    };
  }
  const pending = !!(
    canDetect &&
    !landmarks &&
    typeof options.onRefined === "function"
  );
  const instant = { ...paint(landmarks), pendingAlignment: pending };
  if (pending) {
    detectBodyPose(person, base)
      .then((points) => {
        if (
          renderVersions.get(canvas) !== version ||
          canvas.isConnected === false
        )
          return;
        options.onRefined({
          ...(points ? paint(points) : instant),
          pendingAlignment: false,
        });
      })
      .catch(() => {
        if (
          renderVersions.get(canvas) === version &&
          canvas.isConnected !== false
        )
          options.onRefined({ ...instant, pendingAlignment: false });
      });
  }
  return instant;
}
