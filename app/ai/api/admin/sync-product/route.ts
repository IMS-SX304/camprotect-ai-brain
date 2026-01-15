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
 * {
 *   "webflowProductId": "xxxxx"
 * }
 */
export async function POST(req: Request) {
  try {
    const unauth = assertAdmin(req);
    if (unauth) return unauth;

    const body = await req.json().catch(() => ({}));
    const webflowProductId = (body?.webflowProductId || "").toString().trim();

    if (!webflowProductId) {
      return new Response(JSON.stringify({ ok: false, error: "Missing webflowProductId" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    const result = await syncWebflowProduct(webflowProductId);

    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (e: any) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "Internal error",
        details: e?.message || String(e),
      }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }
}
