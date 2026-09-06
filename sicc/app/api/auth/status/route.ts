import { database, getSession } from "../../../auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const operator = await getSession();
  if (operator) return Response.json({ operator });
  const count = await database().prepare("SELECT COUNT(*) AS count FROM operators").first<{ count: number }>();
  // O Site está privado e somente o proprietário consegue chegar a esta tela.
  // A primeira conta deve poder ser ativada mesmo quando o runtime não expõe
  // variáveis de ambiente ao Worker; o endpoint ainda valida o proprietário.
  const bootstrapAllowed = Number(count?.count ?? 0) === 0;
  return Response.json({ operator: null, bootstrapAllowed });
}
