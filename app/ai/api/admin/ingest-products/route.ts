// app/ai/api/admin/ingest-products/route.ts
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { openaiJson } from "@/lib/openai";

export const runtime = "nodejs";

function requireAdmin(req: Request) {
  const token = req.headers.get("x-admin-token");
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) throw new Error("Missing env ADMIN_TOKEN");
  if (!token || token !== expected) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
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

// construit un texte "RAG-friendly" à partir de la row products
function productRowToChunk(p: any) {
  const lines: string[] = [];

  const name = (p?.name || "").toString().trim();
  const ref = (p?.product_reference || p?.sku || "").toString().trim();
  const url = (p?.url || "").toString().trim();

  if (name) lines.push(`Nom: ${name}`);
  if (ref) lines.push(`Référence: ${ref}`);
  if (p?.brand) lines.push(`Marque: ${p.brand}`);
  if (p?.product_type) lines.push(`Type: ${p.product_type}`);
  if (typeof p?.price === "number") lines.push(`Prix: ${p.price} ${p.currency || "EUR"}`);
  if (url) lines.push(`URL: ${url}`);

  // payload brut (jsonb) = ton or IA
  // on récupère quelques champs fréquents s'ils existent
  const payload = p?.payload || {};
  const desc =
    payload?.description_complete ||
    payload?.["description-complete"] ||
    payload?.description ||
    p?.description ||
    "";

  const altword = payload?.altword || p?.altword || "";
  const benef = payload?.["benefice-court"] || p?.benefice_court || "";
  const meta = payload?.["meta-description"] || p?.meta_description || "";
  const fiche = payload?.["fiche-technique-du-produit"]?.url || p?.fiche_technique_url || "";

  if (desc) lines.push(`Description: ${String(desc)}`);
  if (benef) lines.push(`Bénéfice: ${String(benef)}`);
  if (meta) lines.push(`Meta: ${String(meta)}`);
  if (altword) lines.push(`Altwords: ${String(altword)}`);
  if (fiche) lines.push(`Fiche technique: ${String(fiche)}`);

  // fallback: si c'est vide, on garde au moins payload stringify
  if (lines.length <= 1 && payload && Object.keys(payload).length) {
    lines.push(`Données: ${JSON.stringify(payload)}`);
  }

  return lines.join("\n");
}

export async function POST(req: Request) {
  const authFail = requireAdmin(req);
  if (authFail) return authFail;

  const body = await req.json().catch(() => ({}));

  const offset = clampInt(body?.offset, 0, 0, 1_000_000);
  const limit = clampInt(body?.limit, 50, 1, 250);
  const batchSize = clampInt(body?.batchSize, 10, 1, 50);
  const delayMs = clampInt(body?.delayMs, 120, 0, 5000);

  const supa = supabaseAdmin();

  // 1) On lit des produits depuis la table products (déjà sync Webflow)
  // NB: on lit limit, puis on en traite batchSize pour éviter timeout
  const { data: products, error: readErr } = await supa
    .from("products")
    .select("id, name, brand, product_type, product_reference, sku, url, price, currency, description, altword, benefice_court, meta_description, fiche_technique_url, payload")
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);

  if (readErr) {
    return Response.json({ ok: false, error: "Supabase read products failed", details: readErr.message }, { status: 500 });
  }

  const totalFound = products?.length ?? 0;
  const slice = (products || []).slice(0, batchSize);

  const embedModel = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";
  const dim = Number(process.env.EMBED_DIM || 1536);

  if (!Number.isFinite(dim)) {
    return Response.json({ ok: false, error: "Invalid EMBED_DIM" }, { status: 500 });
  }

  let ingested = 0;
  let failed = 0;
  const errors: any[] = [];

  for (const p of slice) {
    const chunk = productRowToChunk(p);

    try {
      const emb = await openaiJson("embeddings", {
        model: embedModel,
        input: chunk,
      });

      const vector = emb?.data?.[0]?.embedding;
      if (!Array.isArray(vector) || vector.length !== dim) {
        throw new Error(`Embedding wrong dim (got ${vector?.length ?? "null"} expected ${dim})`);
      }

      const meta = {
        type: "product",
        webflow_product_id: p?.webflow_product_id ?? null,
        sku: p?.sku ?? null,
        product_reference: p?.product_reference ?? null,
        brand: p?.brand ?? null,
        url: p?.url ?? null,
      };

      // 2) UPSERT dans product_chunks (colonnes: product_id, chunk, meta, embedding)
      const { error: upErr } = await supa
        .from("product_chunks")
        .upsert(
          {
            product_id: p.id,
            chunk,
            meta,
            embedding: vector,
          },
          { onConflict: "product_id,chunk" } // nécessite l'index unique
        );

      if (upErr) throw new Error(`chunk upsert failed: ${upErr.message}`);

      ingested++;
    } catch (e: any) {
      failed++;
      errors.push({ productId: p?.id, error: "INGEST_FAILED", details: String(e?.message || e) });
    }

    if (delayMs) await sleep(delayMs);
  }

  const nextOffset = offset + slice.length;
  const done = (products || []).length === 0 || slice.length === 0;

  return Response.json({
    ok: true,
    mode: "batch",
    offset,
    limit,
    batchSize,
    nextOffset,
    done,
    totalFound,
    ingested,
    failed,
    errors,
  });
}
