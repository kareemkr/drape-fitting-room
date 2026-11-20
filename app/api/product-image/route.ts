import { handleProductImage } from "../../../lib/fitting/importer.mjs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return handleProductImage(request);
}
