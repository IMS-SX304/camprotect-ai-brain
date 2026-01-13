// app/ai/api/admin/sync-products/route.ts
import { webflowJson } from "@/lib/webflow";
import { syncWebflowProduct } from "@/lib/syncWebflowProduct";

export const runtime = "nodejs";
// si ton hébergeur/Next le supporte, ça évite certains timeouts
export const maxDuration = 60;

function assertAdmin(req: Request) {
  const admin = process.env.ADMIN_TOKEN;
  const got = req.headers.get("x-admin-token");
  if (!admin || !got || got !== admin) {
    return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  return null;
}

function clampInt(v: any, def: number, min: number, max: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * POST /ai/api/admin/sync-products
 * Body optionnel:
 * {
 *   "offset": 0,
 *   "limit": 250,     // plafond webflow, MAIS on ne lira jamais plus que batchSize
 *   "batchSize": 10,  // combien on sync dans CET appel
 *   "delayMs": 120
 * }
 */
export async function POST(req: Request) {
  const unauth = assertAdmin(req);
  if (unauth) return unauth;

  const siteId = process.env.WEBFLOW_SITE_ID;
  if (!siteId) {
    return Response.json({ ok: false, error: "Missing WEBFLOW_SITE_ID" }, { status: 500 });
  }

  const body = await req.json().catch(() => ({}));

  const offset = clampInt(body?.offset, 0, 0, 1_000_000);
  const limit = clampInt(body?.limit, 250, 1, 250);
  const batchSize = clampInt(body?.batchSize, 10, 1, 50);
  const delayMs = clampInt(body?.delayMs, 120, 0, 2000);

  // ✅ IMPORTANT: on lit seulement ce qu'on va traiter
  const readLimit = Math.min(limit, batchSize);

  // 1) On récupère une mini-page Webflow (ex: 5/10 items)
  const page = await webflowJson(
    `/sites/${siteId}/products?offset=${offset}&limit=${readLimit}`,
    { method: "GET" }
  );

  const items = page?.items || [];
  const totalFound = page?.pagination?.total ?? null;

  const errors: any[] = [];
  let synced = 0;
  let failed = 0;

  for (const it of items) {
    const id = it?.product?.id || it?.id;
    if (!id) continue;

    try {
      await syncWebflowProduct(id);
      synced++;
    } catch (e: any) {
      failed++;
      errors.push({ id, error: "SYNC_FAILED", details: String(e?.message || e) });
    }

    if (delayMs) await sleep(delayMs);
  }

  const nextOffset = offset + items.length;

  const done =
    items.length === 0 ||
    (totalFound !== null && nextOffset >= totalFound);

  return Response.json({
    ok: true,
    totalFound,
    offset,
    limit,
    batchSize,
    readLimit,
    nextOffset,
    done,
    synced,
    failed,
    errors,
  });
}
