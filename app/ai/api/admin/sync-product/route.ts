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

export async function POST(req: Request) {
  const unauth = assertAdmin(req);
  if (unauth) return unauth;

  const body = await req.json().catch(() => ({}));
  const webflowProductId = body?.webflowProductId as string | undefined;

  if (!webflowProductId) {
    return Response.json({ ok: false, error: "Missing webflowProductId" }, { status: 400 });
  }

  try {
    const result = await syncWebflowProduct(webflowProductId);
    return Response.json({ ok: true, ...result });
  } catch (e: any) {
    return Response.json(
      { ok: false, error: "sync-product failed", details: String(e?.message || e) },
      { status: 500 }
    );
  }
}
