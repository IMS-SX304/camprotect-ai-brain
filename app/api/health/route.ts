export async function GET() {
  return new Response(JSON.stringify({ ok: true, service: "camprotect-ai-brain" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
