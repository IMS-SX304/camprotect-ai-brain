import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { openaiJson } from "@/lib/openai";

export const runtime = "nodejs"; // important sur Webflow Cloud/OpenNext

type ChatBody = {
  input: string;
  conversationId?: string;
  topK?: number;
};

export async function POST(req: Request) {
  const body = (await req.json()) as ChatBody;
  const input = (body.input || "").trim();
  if (!input) {
    return Response.json({ ok: false, error: "Missing input" }, { status: 400 });
  }

  const supa = supabaseAdmin();
  const topK = body.topK ?? 6;

  // 1) Embed la question
  const embedModel = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";
  const embed = await openaiJson("embeddings", {
    model: embedModel,
    input,
  });
  const queryEmbedding = embed.data[0].embedding;

  // 2) Récupère du contexte depuis Supabase (RAG)
  const { data: docs, error: matchErr } = await supa.rpc("match_documents", {
    query_embedding: queryEmbedding,
    match_count: topK,
  });

  if (matchErr) {
    return Response.json(
      { ok: false, error: "Supabase match_documents failed", details: matchErr.message },
      { status: 500 }
    );
  }

  const context = (docs || [])
    .map((d: any, i: number) => {
      const src = [d.source, d.url].filter(Boolean).join(" | ");
      return `### Source ${i + 1}\n${src}\n${d.chunk}`;
    })
    .join("\n\n");

  // 3) (optionnel) log conversation
  let conversationId = body.conversationId;
  if (!conversationId) {
    const created = await supa.from("conversations").insert({}).select("id").single();
    conversationId = created.data?.id;
  }
  if (conversationId) {
    await supa.from("messages").insert([
      { conversation_id: conversationId, role: "user", content: input },
    ]);
  }

  // 4) Appel modèle chat
  const chatModel = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const system = `Tu es l’assistant CamProtect.
Objectif: aider un client à choisir/installer/configurer du matériel de vidéosurveillance/sécurité (Hikvision, Dahua, Ajax, NVR/DVR, PoE, réseau).
Règles:
- Réponds en français, concret et orienté solution.
- Si une info manque, pose 1 à 3 questions ciblées.
- Appuie-toi sur le CONTEXTE fourni si pertinent, sinon dis-le clairement.
- Ne fabrique pas de caractéristiques techniques.`;

  const user = `Question client:\n${input}\n\nCONTEXTE (extraits de docs/FAQ/produits):\n${context || "(aucun contexte trouvé)"}\n`;

  const completion = await openaiJson("chat/completions", {
    model: chatModel,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.2,
  });

  const reply = completion.choices?.[0]?.message?.content?.trim() || "";

  if (conversationId && reply) {
    await supa.from("messages").insert([
      { conversation_id: conversationId, role: "assistant", content: reply },
    ]);
  }

  return Response.json({
    ok: true,
    conversationId,
    reply,
    rag: { used: (docs || []).length },
  });
}
