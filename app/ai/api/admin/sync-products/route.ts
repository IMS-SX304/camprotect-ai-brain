// app/ai/api/admin/sync-products/route.ts
import { listProducts } from "@/lib/webflow";

export const runtime = "nodejs";

function assertAdmin(req: Request) {
  const admin = process.env.ADMIN_TOKEN;
  const got = req.headers.get("x-admin-token");
  if (!admin || !got || got !== admin) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export async function POST(req: Request) {
  const unauth = assertAdmin(req);
  if (unauth) return unauth;

  const siteId = process.env.WEBFLOW_SITE_ID;
  if (!siteId) {
    return Response.json({ ok: false, error: "Missing WEBFLOW_SITE_ID" }, { status: 500 });
  }

  const limit = 250;
  let offset = 0;
  const ids: string[] = [];

  try {
    while (true) {
      const page = await listProducts(siteId, offset, limit);
      const items = Array.isArray(page?.items) ? page.items : [];

      for (const it of items) {
        const id = it?.product?.id;
        if (typeof id === "string" && id) ids.push(id);
      }

      if (items.length < limit) break;
      offset += limit;
    }

    const origin = new URL(req.url).origin;

    let okCount = 0;
    const errors: Array<{ id: string; error: string }> = [];

    for (const id of ids) {
      const r = await fetch(`${origin}/ai/api/admin/sync-product`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": req.headers.get("x-admin-token") || "",
        },
        body: JSON.stringify({ webflowProductId: id }),
      });

      const j = await r.json().catch(() => null);
      if (r.ok && j?.ok) okCount++;
      else errors.push({ id, error: j?.details || j?.error || `HTTP ${r.status}` });
    }

    return Response.json({
      ok: true,
      totalFound: ids.length,
      synced: okCount,
      failed: errors.length,
      errors: errors.slice(0, 25),
    });
  } catch (e: any) {
    return Response.json(
      { ok: false, error: "Internal error", details: String(e?.message || e) },
      { status: 500 }
    );
  }
}
