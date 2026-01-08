// app/ai/api/admin/sync-product/route.ts
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

/**
 * POST /ai/api/admin/sync-product
 * Body:
 * { "webflowProductId": "..." }
 */
export async function POST(req: Request) {
  const unauth = assertAdmin(req);
  if (unauth) return unauth;

  try {
    const body = await req.json().catch(() => ({}));
    const webflowProductId = String(body?.webflowProductId || "").trim();

    if (!webflowProductId) {
      return Response.json({ ok: false, error: "Missing webflowProductId" }, { status: 400 });
    }

    const result = await syncWebflowProduct(webflowProductId);

    // ✅ Une seule fois "ok"
    return Response.json({ ok: true, result });
  } catch (e: any) {
    return Response.json(
      { ok: false, error: "Internal error", details: String(e?.message || e) },
      { status: 500 }
    );
  }
}
