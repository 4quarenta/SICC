import { requireSession } from "../../../auth";

export const dynamic = "force-dynamic";

function database() {
  const binding = (globalThis as typeof globalThis & { __SICC_DB?: D1Database }).__SICC_DB;
  if (!binding) throw new Error("Banco de dados indisponível.");
  return binding;
}

function bucket() {
  const binding = (globalThis as typeof globalThis & { __SICC_BUCKET?: R2Bucket }).__SICC_BUCKET;
  if (!binding) throw new Error("Armazenamento de imagens indisponível.");
  return binding;
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  if (!await requireSession()) {
    return new Response("Acesso não autenticado.", { status: 401 });
  }
  const { id } = await context.params;
  const media = await database()
    .prepare("SELECT object_key, content_type FROM person_media WHERE id = ?")
    .bind(Number(id))
    .first<{ object_key: string; content_type: string }>();
  if (!media) return new Response("Imagem não encontrada.", { status: 404 });
  const object = await bucket().get(media.object_key);
  if (!object) return new Response("Imagem não encontrada.", { status: 404 });
  return new Response(object.body, {
    headers: {
      "content-type": media.content_type,
      "cache-control": "private, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
}
