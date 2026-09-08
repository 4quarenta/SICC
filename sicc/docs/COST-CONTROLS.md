# Controles de custo

O SICC publicado usa GitHub Pages para o frontend e Supabase para API, banco,
Auth e Storage. Não há R2, D1, Cloudflare Worker ou escrita no filesystem.

- Mantenha o bucket sicc-media privado.
- Comprimir imagens no navegador antes do upload; rejeitar MIME/tamanho fora
  do limite.
- Remover o objeto do Storage quando a mídia ou o cadastro for apagado.
- Monitorar uso do banco, Storage, egress e invocações da Edge Function no
  painel Supabase.
- Manter spend cap/limites do plano Free; não habilitar upgrade automático.
- Não colocar service_role, tokens ou dumps no GitHub.

Uploads de fotos são referências no PostgreSQL e objetos no Storage. O parser
do Infoseg é local e não cria consumo de API externa.