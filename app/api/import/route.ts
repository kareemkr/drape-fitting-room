import { handleImport } from "../../../lib/fitting/importer.mjs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return handleImport(request);
}
