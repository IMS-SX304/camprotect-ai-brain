// app/ai/api/admin/sync-webflow-options/route.ts
import { webflowJson } from "@/lib/webflow";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

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
 * POST /ai/api/admin/sync-webflow-options
 * Body:
 * {
 *   "collectionId": "xxxx",        // obligatoire
 *   "fieldSlugs": ["fabricants"]   // optionnel, sinon on sync tout
 * }
 */
export async function POST(req: Request) {
  try {
    const unauth = assertAdmin(req);
    if (unauth) return unauth;

    const body = await req.json().catch(() => ({}));
    const collectionId = String(body?.collectionId || "").trim();
    if (!collectionId) {
      return Response.json({ ok: false, error: "Missing collectionId" }, { status: 400 });
    }

    const onlyFieldSlugs: string[] | null = Array.isArray(body?.fieldSlugs)
      ? body.fieldSlugs.map((s: any) => String(s).trim()).filter(Boolean)
      : null;

    // ✅ IMPORTANT : adapte le endpoint à celui que tu utilises déjà dans Webflow API
    // Si chez toi c’est “Get collection details”, l’endpoint est souvent /collections/{collectionId}
    const details = await webflowJson(`/collections/${collectionId}`, { method: "GET" });

    const fields = Array.isArray(details?.fields) ? details.fields : [];
    if (!fields.length) {
      return Response.json(
        { ok: false, error: "No fields found in collection details", gotKeys: Object.keys(details || {}) },
        { status: 500 }
      );
    }

    const rows: Array<{ field_slug: string; option_id: string; option_name: string; updated_at: string }> = [];
    const now = new Date().toISOString();

    for (const f of fields) {
      const slug = String(f?.slug || "").trim();
      const type = String(f?.type || "").trim(); // "Option"
      if (!slug || type !== "Option") continue;
      if (onlyFieldSlugs && !onlyFieldSlugs.includes(slug)) continue;

      const opts = f?.validations?.options;
      if (!Array.isArray(opts)) continue;

      for (const o of opts) {
        const option_name = String(o?.name || "").trim();
        const option_id = String(o?.id || "").trim();
        if (!option_name || !option_id) continue;

        rows.push({ field_slug: slug, option_id, option_name, updated_at: now });
      }
    }

    if (!rows.length) {
      return Response.json({ ok: true, synced: 0, message: "No option fields matched" });
    }

    const supa = supabaseAdmin();

    const { error } = await supa
      .from("webflow_option_map")
      .upsert(rows, { onConflict: "field_slug,option_id" });

    if (error) {
      return Response.json({ ok: false, error: "Supabase upsert failed", details: error.message }, { status: 500 });
    }

    return Response.json({ ok: true, synced: rows.length, fields: [...new Set(rows.map(r => r.field_slug))] });
  } catch (e: any) {
    return Response.json({ ok: false, error: "Internal error", details: e?.message || String(e) }, { status: 500 });
  }
}
