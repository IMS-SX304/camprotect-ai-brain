import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { openaiJson } from "@/lib/openai";

export const runtime = "nodejs";

type ProductInput = {
  sku?: string;
  name: string;
  brand?: string;
  product_type?: string;
  url?: string;
  price?: number;
  currency?: string;
  // tout le reste (description, specs, etc.)
  [k: string]: any;
};

function requireAdmin(req: Request) {
  const token = req.headers.get("x-admin-token");
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) throw new Error("Missing env ADMIN_TOKEN");
  if (!token || token !== expected) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

function productToText(p: ProductInput) {
  // On fabrique un texte "RAG friendly" (simple + efficace)
  const lines: string[] = [];
  lines.push(`Nom: ${p.name}`);
  if (p.sku) lines.push(`Référence: ${p.sku}`);
  if (p.brand) lines.push(`Marque: ${p.brand}`);
  if (p.product_type) lines.push(`Type: ${p.product_type}`);
  if (typeof p.price === "number") lines.push(`Prix: ${p.price} ${p.currency || "EUR"}`);
  if (p.url) lines.push(`URL: ${p.url}`);

  // Ajoute toutes les infos utiles si présentes
  if (p.description) lines.push(`Description: ${p.description}`);
  if (p.features) lines.push(`Fonctions: ${Array.isArray(p.features) ? p.features.join(", ") : String(p.features)}`);
  if (p.specs) lines.push(`Spécifications: ${typeof p.specs === "string" ? p.specs : JSON.stringify(p.specs)}`);

  return lines.join("\n");
}

export async function POST(req: Request) {
  const authFail = requireAdmin(req);
  if (authFail) return authFail;

  const body = await req.json().catch(() => null);
  const items: ProductInput[] = body?.products;

  if (!Array.isArray(items) || items.length === 0) {
    return Response.json({ ok: false, error: "Missing products[]" }, { status: 400 });
  }

  const supa = supabaseAdmin();

  const embedModel = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";
  const dim = Number(process.env.EMBED_DIM || 1536);
  if (!Number.isFinite(dim)) {
    return Response.json({ ok: false, error: "Invalid EMBED_DIM" }, { status: 500 });
  }

  // 1) Upsert products (source de vérité)
  const productsRows = items.map((p) => ({
    sku: p.sku || null,
    name: p.name,
    brand: p.brand || null,
    product_type: p.product_type || null,
    url: p.url || null,
    price: typeof p.price === "number" ? p.price : null,
    currency: p.currency || "EUR",
    payload: p, // on stocke le JSON brut
    updated_at: new Date().toISOString(),
  }));

  const { error: prodErr } = await supa.from("products").upsert(productsRows, {
    onConflict: "sku",
    ignoreDuplicates: false,
  });

  if (prodErr) {
    return Response.json({ ok: false, error: "Supabase products upsert failed", details: prodErr.message }, { status: 500 });
  }

  // 2) Créer documents + embeddings (RAG)
  const docsToInsert: any[] = [];

  for (const p of items) {
    const text = productToText(p);

    // Embedding
    const emb = await openaiJson("embeddings", {
      model: embedModel,
      input: text,
    });

    const vector = emb?.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length !== dim) {
      return Response.json(
        { ok: false, error: "Embedding failed or wrong dim", got: vector?.length ?? null, expected: dim },
        { status: 500 }
      );
    }

    docsToInsert.push({
      source: "webflow-products",
      title: p.name,
      url: p.url || null,
      content: text,
      chunk: text,
      metadata: {
        type: "product",
        sku: p.sku || null,
        brand: p.brand || null,
        product_type: p.product_type || null,
      },
      embedding: vector,
      created_at: new Date().toISOString(),
    });
  }

  // Remarque : on peut garder plusieurs versions, mais pour démarrer on remplace par SKU+name.
  // Si tu veux du strict-upsert côté documents, on ajoutera une contrainte unique + onConflict.
  const { error: docErr } = await supa.from("documents").insert(docsToInsert);

  if (docErr) {
    return Response.json({ ok: false, error: "Supabase documents insert failed", details: docErr.message }, { status: 500 });
  }

  return Response.json({
    ok: true,
    inserted_products: items.length,
    inserted_documents: docsToInsert.length,
  });
}
