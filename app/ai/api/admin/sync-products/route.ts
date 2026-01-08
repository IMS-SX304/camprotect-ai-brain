// app/ai/api/admin/sync-products/route.ts

import { webflowJson } from "@/lib/webflow";

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

export async function POST(req: Request) {
  const unauth = assertAdmin(req);
  if (unauth) return unauth;

  const siteId = process.env.WEBFLOW_SITE_ID;
  if (!siteId) {
    return Response.json({ ok: false, error: "Missing WEBFLOW_SITE_ID" }, { status: 500 });
  }

  // Webflow renvoie souvent max 100 items/page
  const limit = 100;
  let offset = 0;

  const errors: any[] = [];
  let synced = 0;
  let failed = 0;
  let totalFound = 0;

  while (true) {
    let page: any;
    try {
      page = await webflowJson(`/sites/${siteId}/products?offset=${offset}&limit=${limit}`, { method: "GET" });
    } catch (e: any) {
      return Response.json({ ok: false, error: "Webflow list failed", details: String(e?.message || e) }, { status: 500 });
    }

    const items = page?.items || [];
    if (offset === 0) {
      // Certains endpoints donnent total ailleurs, sinon on approx
      totalFound = page?.pagination?.total ?? items.length;
    }

    if (!items.length) break;

    for (const it of items) {
      const webflowProductId = it?.product?.id || it?.id;
      if (!webflowProductId) continue;

      try {
        // On appelle le sync-product interne (même host)
        const r = await fetch(new URL("/ai/api/admin/sync-product", req.url), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-admin-token": req.headers.get("x-admin-token") || "",
          },
          body: JSON.stringify({ webflowProductId }),
        });

        const j = await r.json().catch(() => null);
        if (!r.ok || !j?.ok) {
          failed++;
          errors.push({ webflowProductId, status: r.status, error: j?.error, details: j?.details });
        } else {
          synced++;
        }
      } catch (e: any) {
        failed++;
        errors.push({ webflowProductId, error: "sync-product fetch failed", details: String(e?.message || e) });
      }
    }

    offset += limit;

    // Stop si on a atteint la fin (quand moins que limit)
    if (items.length < limit) break;
  }

  return Response.json({
    ok: true,
    totalFound,
    synced,
    failed,
    errors,
  });
}
