// app/ai/api/chat/route.ts

export const runtime = "nodejs"; // important sur Webflow/OpenNext

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export async function GET() {
  return new Response(
    JSON.stringify({
      ok: true,
      hint: "Use POST /ai/api/chat with JSON body { input: string }",
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}


export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as
      | { messages?: ChatMessage[]; input?: string }
      | null;

    const messages = body?.messages ?? [];
    const input = body?.input;

    // On récupère le dernier message user (si messages[] fourni)
    const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content;

    const text =
      (typeof input === "string" && input.trim()) ||
      (typeof lastUser === "string" && lastUser.trim()) ||
      "";

    if (!text) {
      return json(
        { ok: false, error: "Missing input. Provide { input: string } or { messages: [...] }." },
        400
      );
    }

    // Réponse mock (pour valider que le POST fonctionne)
    const reply = `✅ Mock reply: j'ai bien reçu: "${text}"`;

    return json({
      ok: true,
      reply,
      received: text,
      usage: { mode: "mock" },
    });
  } catch (e: any) {
    return json(
      {
        ok: false,
        error: "Server error",
        details: e?.message ?? String(e),
      },
      500
    );
  }
}

// Helper JSON + headers
function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // CORS "cool" pour tests (on resserrera après)
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-api-key",
    },
  });
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-api-key",
    },
  });
}

