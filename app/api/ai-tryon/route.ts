import { env } from "cloudflare:workers";
import { handleStudioAi } from "../../../lib/fitting/studio-ai-service.mjs";

export const dynamic = "force-dynamic";
type StudioEnv = {
  DRAPE_LOCAL_ONLY?: string;
  FASHN_API_KEY?: string;
  DRAPE_RENDER_TOKEN?: string;
  DRAPE_RENDER_URL?: string;
};

function handle(request: Request) {
  return handleStudioAi(request, env as StudioEnv);
}

export { handle as GET, handle as POST };
