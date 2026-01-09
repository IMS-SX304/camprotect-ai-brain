// app/ai/api/admin/ingest-products/route.ts
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { openaiJson } from "@/lib/openai";

export const runtime = "nodejs";

function assertAdmin(req: Request) {
  const expected = process.env.ADMIN_TOKEN;
  const got = req.headers.get("x-admin-token");
  if (!expected || !got || got !== expected) {
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

function chunkText(text: string, maxChars = 2200) {
  const clean = (text || "").trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  const out: string[] = [];
  let buf = "";
  const parts = clean.split(/\n+/);

  for (const p of parts) {
    const line = p.trim();
    if (!line) continue;

    if ((buf + "\n" + line).length > maxChars) {
      if (buf.trim()) out.push(buf.trim());
      buf = line;
    } else {
      buf = buf ? `${buf}\n${line}` : line;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

async function sha1Hex(input: string) {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-1", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function productToRagText(p: any, variants: any[]) {
  const lines: string[] = [];

  if (p?.name) lines.push(`Nom: ${p.name}`);
  if (p?.product_reference) lines.push(`Référence produit: ${p.product_reference}`);
  if (p?.brand) lines.push(`Marque: ${p.brand}`);
  if (p?.url) lines.push(`URL: ${p.url}`);
  if (p?.price != null) lines.push(`Prix (à partir de): ${p.price} ${p?.currency || "EUR"}`);

  if (p?.benefice_court) lines.push(`Bénéfice: ${p.benefice_court}`);
  if (p?.meta_description) lines.push(`Meta: ${p.meta_description}`);
  if (p?.description) lines.push(`Description: ${p.description}`);
  if (p?.altword) lines.push(`Mots-clés: ${p.altword}`);
  if (p?.fiche_technique_url) lines.push(`Fiche technique: ${p.fiche_technique_url}`);

  if (Array.isArray(variants) && variants.length) {
    lines.push(`Variantes:`);
    for (const v of variants) {
      const vLine: string[] = [];
      if (v?.sku) vLine.push(`SKU ${v.sku}`);
      if (v?.name) vLine.push(`${v.name}`);
      if (v?.price != null) vLine.push(`= ${v.price} ${v?.currency || "EUR"}`);
      if (vLine.length) lines.push(`- ${vLine.join(" ")}`);
    }
  }

  return lines.join("\n").trim();
}

async function ingestOneProduct(sb: any, p: any, embedModel: string, dim: number) {
  const { data: vars, error: varErr } = await sb
    .from("product_variants")
    .select("sku, name, price, currency")
    .eq("product_id", p.id);

  if (varErr) throw new Error(`variants read failed: ${varErr.message}`);

  const ragText = productToRagText(p, vars || []);
  const chunks = chunkText(ragText, 2200);
  if (!chunks.length) throw new Error("EMPTY_TEXT");

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunk_hash = await sha1Hex(`${p.id}:${i}:${chunk}`);

    const emb = await openaiJson("embeddings", { model: embedModel, input: chunk });
    const vector = emb?.data?.[0]?.embedding;

    if (!Array.isArray(vector) || vector.length !== dim) {
      throw new Error(`embedding bad dim: got=${vector?.length ?? null} expected=${dim}`);
    }

    const row = {
      product_id: p.id,
      chunk,
      chunk_hash,
      meta: {
        webflow_product_id: p.webflow_product_id || null,
        slug: p.slug || null,
        url: p.url || null,
        product_reference: p.product_reference || null,
        name: p.name || null,
        brand: p.brand || null,
        chunk_index: i,
      },
      embedding: vector,
    };

    const { error: upErr } = await sb
      .from("product_chunks")
      .upsert(row, { onConflict: "product_id,chunk_hash" });

    if (upErr) throw new Error(`chunk upsert failed: ${upErr.message}`);
  }
}

/**
 * POST /ai/api/admin/ingest-products
 *
 * Mode A (batch auto):
 * { offset, limit, batchSize, delayMs }
 *
 * Mode B (ciblé):
 * { products: [260,261] }  // ids de products (bigint)
 */
export async function POST(req: Request) {
  const unauth = assertAdmin(req);
  if (unauth) return unauth;

  const body = await req.json().catch(() => ({}));

  const sb = supabaseAdmin();

  const embedModel = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";
  const dim = Number(process.env.EMBED_DIM || 1536);

  // ===== MODE B : ingest ciblé via products[] =====
  const productsList = body?.products;
  if (Array.isArray(productsList) && productsList.length > 0) {
    const ids = productsList.map((x: any) => Number(x)).filter((n: number) => Number.isFinite(n));

    if (!ids.length) {
      return Response.json({ ok: false, error: "Invalid products[] ids" }, { status: 400 });
    }

    const { data: products, error: prodErr } = await sb
      .from("products")
      .select("id, webflow_product_id, slug, url, name, brand, product_reference, price, currency, description, altword, benefice_court, meta_description, fiche_technique_url")
      .in("id", ids);

    if (prodErr) {
      return Response.json({ ok: false, error: "Supabase products read failed", details: prodErr.message }, { status: 500 });
    }

    const errors: any[] = [];
    let ingested = 0;
    let failed = 0;

    for (const p of products || []) {
      try {
        await ingestOneProduct(sb, p, embedModel, dim);
        ingested++;
      } catch (e: any) {
        failed++;
        errors.push({ productId: p?.id, error: "INGEST_FAILED", details: String(e?.message || e) });
      }
    }

    return Response.json({ ok: true, mode: "products[]", ingested, failed, errors });
  }

  // ===== MODE A : batch auto via offset/limit/batchSize =====
  const offset = clampInt(body?.offset, 0, 0, 1_000_000);
  const limit = clampInt(body?.limit, 50, 1, 250);
  const batchSize = clampInt(body?.batchSize, 5, 1, 50);
  const delayMs = clampInt(body?.delayMs, 120, 0, 2000);

  const { count: totalFound, error: countErr } = await sb
    .from("products")
    .select("id", { count: "exact", head: true });

  if (countErr) {
    return Response.json({ ok: false, error: "Supabase count failed", details: countErr.message }, { status: 500 });
  }

  const { data: products, error: prodErr } = await sb
    .from("products")
    .select("id, webflow_product_id, slug, url, name, brand, product_reference, price, currency, description, altword, benefice_court, meta_description, fiche_technique_url")
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);

  if (prodErr) {
    return Response.json({ ok: false, error: "Supabase products read failed", details: prodErr.message }, { status: 500 });
  }

  const slice = (products || []).slice(0, batchSize);

  const errors: any[] = [];
  let ingested = 0;
  let failed = 0;

  for (const p of slice) {
    try {
      await ingestOneProduct(sb, p, embedModel, dim);
      ingested++;
    } catch (e: any) {
      failed++;
      errors.push({ productId: p?.id, error: "INGEST_FAILED", details: String(e?.message || e) });
    }
    if (delayMs) await sleep(delayMs);
  }

  const nextOffset = offset + slice.length;
  const done = !products?.length || (typeof totalFound === "number" && nextOffset >= totalFound);

  return Response.json({
    ok: true,
    mode: "batch",
    totalFound,
    offset,
    limit,
    batchSize,
    nextOffset,
    done,
    ingested,
    failed,
    errors,
  });
}

export async function GET() {
  return Response.json({ ok: true, route: "ingest-products", version: "v2-batch-compat" });
}
