import { buildTopMesh } from "./live-top.js";
import { buildFullBodyMesh } from "./live-fullbody.js";
import { drawUpperMesh } from "./upper-warp.js";
import { createTexturePainter } from "./live-texture.js";
import { createLiveWaistTracker, projectLiveWaist } from "./live-waist.js";
import { createLiveOcclusion } from "./live-occlusion.js";
import { createLiveOutline } from "./live-outline.js";
import { createLiveLighting } from "./live-lighting.js";

function adjustPlacement(mesh, fit, frame) {
  if (!fit) return;
  const { scale = 1, rotation = 0, dx = 0, dy = 0 } = fit;
  if (scale === 1 && rotation === 0 && dx === 0 && dy === 0) return;
  const pivot = mesh.rings?.waist?.[1] ?? mesh.pivot;
  if (!pivot) return;
  const c = Math.cos(rotation * Math.PI / 180) * scale;
  const s = Math.sin(rotation * Math.PI / 180) * scale;
  function transform(point) {
    const x = point.x - pivot.x, y = point.y - pivot.y;
    return { x: pivot.x + dx * frame.width + c * x - s * y,
             y: pivot.y + dy * frame.height + s * x + c * y };
  }
  for (const vertex of mesh.vertices) vertex.t = transform(vertex.t);
  if (mesh.rings) {
    mesh.rings = { waist: mesh.rings.waist.map(transform), hem: mesh.rings.hem.map(transform) };
  }
  if (mesh.pivot) mesh.pivot = transform(mesh.pivot);
}

// All fitting, light sampling and foreground compositing share unmirrored pixels.
export function createLiveGarmentRenderer(canvas, { still = false } = {}) {
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) throw new Error("Your browser could not open the fitting canvas.");
  const gpu = still ? null : createTexturePainter();
  const waist = createLiveWaistTracker();
  const outline = createLiveOutline();
  const lighting = createLiveLighting();
  const occlusion = createLiveOcclusion();
  let rings = null;
  let measured = null;
  let disposed = false;
  function wipe() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    rings = null;
  }
  function clear({ keepPose = false } = {}) {
    wipe();
    if (!keepPose) {
      measured = null;
      waist.reset();
    }
    outline.reset();
    lighting.reset?.();
  }
  function measurePose(points, timestamp = performance.now()) {
    if (disposed) return null;
    const frame = { width: canvas.width, height: canvas.height };
    const sameFrame = measured?.width === frame.width && measured?.height === frame.height;
    if (sameFrame && measured.points === points && measured.timestamp === timestamp) return measured.support;
    const support = waist.update(points, frame, timestamp);
    const previous = sameFrame ? measured.support : null;
    measured = { ...frame, points, timestamp, support, previous };
    return support;
  }
  function supportForDraw(points, frame, options) {
    if (still || options.exact) return options.waistProfile;
    if (!options.measured) return measurePose(points, options.timestamp);
    if (!measured?.support || measured.width !== frame.width || measured.height !== frame.height) return null;
    if (measured.points === points) return measured.support;
    return projectLiveWaist(points, frame, measured.support, measured.previous);
  }
  function draw(product, points, options = {}) {
    wipe();
    if (disposed) return false;
    if (!points || points.length < 33 || !canvas.width || !canvas.height) {
      measured = null;
      waist.reset();
      return false;
    }
    if (!product) return false;
    const frame = { left: 0, top: 0, width: canvas.width, height: canvas.height };
    let mesh;
    if (product.category === "top") {
      const support = supportForDraw(points, frame, options);
      const fitPoints = still || !support || points.outline
        ? points
        : outline.sample(points, options.frame, options.timestamp ?? performance.now());
      mesh = buildTopMesh(fitPoints, frame, product.topProfile, support, options.fit, options.sizeGrade);
    } else {
      mesh = buildFullBodyMesh(points, frame, product.shape, options.sizeGrade);
    }
    if (!mesh) return false;
    adjustPlacement(mesh, options.fit, frame);
    ctx.imageSmoothingEnabled = true;
    if (!gpu?.draw(ctx, product.texture, mesh)) {
      drawUpperMesh(ctx, product.texture, [0, 0, product.texture.width, product.texture.height], mesh);
    }
    lighting.apply(ctx, product, points, options.frame);
    occlusion.draw(ctx, product, points, frame, options.frame, options.backend ?? points.backend);
    rings = mesh.rings ?? null;
    return true;
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    clear();
    gpu?.dispose();
    occlusion.dispose();
  }
  return { draw, clear, dispose, measurePose, getAnchors: () => rings };
}
