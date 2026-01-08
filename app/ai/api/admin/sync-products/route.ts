// app/ai/api/admin/sync-products/route.ts
import { webflowJson } from "@/lib/webflow";
import { syncWebflowProduct } from "@/lib/syncWebflowProduct";

export const runtime = "nodejs";

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
 *   "limit": 50,      // combien on lit chez Webflow (max 250)
 *   "batchSize": 10,  // combien on sync réellement dans cette requête
 *   "delayMs": 120    // pause entre sync pour éviter rate limit
 * }
 *
 * Réponse: { ok, totalFound, nextOffset, done, synced, failed, errors[] }
 */
export async function POST(req: Request) {
  const unauth = assertAdmin(req);
  if (unauth) return unauth;

  const siteId = process.env.WEBFLOW_SITE_ID;
  if (!siteId) return Response.json({ ok: false, error: "Missing WEBFLOW_SITE_ID" }, { status: 500 });

  const body = await req.json().catch(() => ({}));

  const offset = clampInt(body?.offset, 0, 0, 1000000);
  const limit = clampInt(body?.limit, 100, 1, 250); // lecture webflow
  const batchSize = clampInt(body?.batchSize, 10, 1, 50); // travail réel dans cette requête
  const delayMs = clampInt(body?.delayMs, 120, 0, 2000);

  // 1) On récupère une page Webflow (jusqu'à 250 items)
  const page = await webflowJson(`/sites/${siteId}/products?offset=${offset}&limit=${limit}`, { method: "GET" });
  const items = page?.items || [];
  const totalFound = page?.pagination?.total ?? null;

  // 2) On ne traite que batchSize produits pour éviter timeout
  const slice = items.slice(0, batchSize);

  const errors: any[] = [];
  let synced = 0;
  let failed = 0;

  for (const it of slice) {
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

  // nextOffset: si on a consommé tout "items" => offset+limit,
  // sinon on continue à la même page en avançant un "offset interne"
  // => pour simplifier: on avance offset de batchSize (pas limit)
  const nextOffset = offset + slice.length;

  const done =
    items.length === 0 ||
    (totalFound !== null && nextOffset >= totalFound);

  return Response.json({
    ok: true,
    totalFound,
    offset,
    limit,
    batchSize,
    nextOffset,
    done,
    synced,
    failed,
    errors,
  });
}
