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

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function POST(req: Request) {
  const unauth = assertAdmin(req);
  if (unauth) return unauth;

  const siteId = process.env.WEBFLOW_SITE_ID;
  if (!siteId) {
    return Response.json({ ok: false, error: "Missing WEBFLOW_SITE_ID" }, { status: 500 });
  }

  const limit = 100;
  let offset = 0;

  const errors: any[] = [];
  let synced = 0;
  let failed = 0;
  let totalFound = 0;

  while (true) {
    const page = await webflowJson(`/sites/${siteId}/products?offset=${offset}&limit=${limit}`, { method: "GET" });
    const items = page?.items || [];

    if (offset === 0) totalFound = page?.pagination?.total ?? items.length;
    if (!items.length) break;

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

      // Petite pause pour éviter rate-limit (safe)
      await sleep(120);
    }

    offset += limit;
    if (items.length < limit) break;
  }

  return Response.json({ ok: true, totalFound, synced, failed, errors });
}
