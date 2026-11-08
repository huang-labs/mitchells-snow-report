import { admin, ADMIN_ROUTES } from "./admin";
import { dailySnow } from "./daily-snow";
import { dailySnowFigure } from "./daily-snow-figure";
import { dailySnowShareImage } from "./daily-snow-share-image";
import type { WorkerEnv } from "./env";
import { plumePanel } from "./plume";
import { report } from "./report";

function methodNotAllowed(allow: string) {
  return new Response("Method not allowed", {
    status: 405,
    headers: { Allow: allow, "Cache-Control": "no-store" },
  });
}

/** Only API and share-image paths need code; asset-first routing serves pages. */
export async function handleFetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const adminMethod = ADMIN_ROUTES[path];
  if (adminMethod) {
    if (!env.ADMIN_TOKEN) return new Response("Not found", { status: 404 });
    return request.method === adminMethod ? admin(request, env) : methodNotAllowed(adminMethod);
  }

  const share=/^\/daily-snow\/([^/]+)\/opengraph-image$/.exec(path);
  const panel = /^\/api\/plume\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);
  const figure = /^\/api\/daily-snow\/figure\/([^/]+)\/([^/]+)$/.exec(path);
  let route: (() => Promise<Response>) | undefined;
  if (path === "/api/report") route = () => report(env);
  else if (path === "/api/daily-snow") route = () => dailySnow(request, env);
  else if (path === "/daily-snow/opengraph-image") route = () => dailySnowShareImage(request, env, ctx);
  else if(share)route=()=>dailySnowShareImage(request,env,ctx,share[1]);
  else if (panel) route = () => plumePanel(env, panel[1], panel[2], panel[3]);
  else if (figure) route = () => dailySnowFigure(env, figure[1], figure[2], url.searchParams.get("v") ?? undefined,url.searchParams.get("channel")??"western-us");
  if (route) {
    if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
    const response = await route();
    if (request.method === "HEAD") {
      await response.body?.cancel();
      return new Response(null, { status: response.status, headers: response.headers });
    }
    return response;
  }

  if (path === "/api" || path.startsWith("/api/")) {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  return env.ASSETS.fetch(request);
}
