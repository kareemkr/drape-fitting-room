import { mapTop } from "./live-top.js";
import { readLiveSilhouette } from "./live-fullbody.js";

function isolateTexture(product) {
  const canvas = document.createElement("canvas");
  const [, , w, h] = product.bounds;
  const factor = Math.min(1, 720 / Math.max(w, h));
  canvas.width = Math.max(1, Math.round(w * factor));
  canvas.height = Math.max(1, Math.round(h * factor));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(
    product.canvas,
    ...product.bounds,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  const collar = product.anatomy?.neckOpening;
  if (collar?.length > 2) {
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    collar.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.x * canvas.width, p.y * canvas.height);
      else ctx.lineTo(p.x * canvas.width, p.y * canvas.height);
    });
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  return canvas;
}

function resemblesFullPortrait(shape) {
  // A narrow crown widening into a head and shrinking into a neck above broad
  // shoulders is a common sign that the retailer image contains a whole model.
  const widths = [0.035, 0.09, 0.15, 0.25].map((y) => {
    const r = shape.rows[Math.round(y * (shape.rows.length - 1))];
    return r.right - r.left;
  });
  const [crown, head, neck, body] = widths;
  return (
    shape.aspect < 0.68 &&
    crown < 0.42 &&
    head < 0.59 &&
    neck < head * 0.84 &&
    body > head * 1.6
  );
}

const prepared = new WeakMap();

export function garmentProduct(product, item) {
  const category = ["bottom", "dress"].includes(item.category) ? item.category : "top";
  const key = JSON.stringify([category, item.name, Boolean(item.studio)]);
  const cached = prepared.get(product);
  if (cached?.key === key) return cached.value;

  const texture = isolateTexture(product);
  const shape = readLiveSilhouette(texture, category, item.name);
  const portrait = !item.studio && resemblesFullPortrait(shape);
  const topProfile = category === "top" ? mapTop(shape, product.anatomy) : null;
  let sleeveLength = product.anatomy?.sleeveLength;
  if (
    !sleeveLength &&
    category === "dress" &&
    (/long[- ]sleeve/i.test(item.name || "") || shape.sleeves?.cuff > 0.34)
  ) {
    sleeveLength = "long";
  }
  const value = {
    texture,
    shape,
    anatomy: product.anatomy,
    topProfile,
    portrait,
    category,
    sleeveLength: topProfile?.sleeveLength ?? sleeveLength,
  };
  prepared.set(product, { key, value });
  return value;
}
