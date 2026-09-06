import { requireSession, database } from "../../../../auth";

export const dynamic = "force-dynamic";

function bucket() {
  const binding = (globalThis as typeof globalThis & { __SICC_BUCKET?: R2Bucket }).__SICC_BUCKET;
  if (!binding) throw new Error("Armazenamento de imagens indisponível.");
  return binding;
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  if (!await requireSession()) return new Response("Acesso não autenticado.", { status: 401 });
  const id = Number((await context.params).id);
  if (!Number.isInteger(id)) return new Response("Imagem inválida.", { status: 400 });
  const media = await database().prepare("SELECT object_key, content_type FROM qtc_alert_media WHERE id = ?").bind(id).first<{ object_key: string; content_type: string }>();
  if (!media) return new Response("Imagem não encontrada.", { status: 404 });
  const object = await bucket().get(media.object_key);
  if (!object) return new Response("Imagem não encontrada.", { status: 404 });
  return new Response(object.body, { headers: { "content-type": media.content_type, "cache-control": "private, max-age=300", "x-content-type-options": "nosniff" } });
}
