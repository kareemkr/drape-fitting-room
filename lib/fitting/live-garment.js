import { prepareGarment } from "./fitting.js";
import { garmentProduct } from "./garment-product.js";
export { createLiveGarmentRenderer } from "./garment-renderer.js";

export async function prepareLiveGarment(item) {
  if (!item?.src) throw new Error("Choose a garment to start the live fitting.");
  const top = !["bottom", "dress"].includes(item.category);
  const raw = await prepareGarment(item.src, true, item.id, top);
  const product = garmentProduct(raw, item);
  if (raw.background === "unchanged" || product.portrait) {
    throw new Error("Choose a garment-only photo on a plain or transparent background for live fitting.");
  }
  return product;
}
