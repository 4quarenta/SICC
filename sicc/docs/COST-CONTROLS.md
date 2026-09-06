# Controles de custo

O projeto não cria automaticamente recursos pagos, não cria branches Supabase e não habilita o plano pago. A organização Supabase verificada está no plano Free, com projeto ativo `wsfvpmypmezljeltarhz`.

As gravações de imagens no R2 estão desativadas por padrão. Só ficam disponíveis quando o administrador define `SICC_STORAGE_WRITE_ENABLED=true` como segredo do ambiente depois de habilitar R2 e revisar os limites. Sem essa variável, a aplicação recusa uploads antes de gravar objetos.

O plano Free da Cloudflare limita Pages Functions a 100.000 requisições por dia; ao atingir esse limite, o projeto deve falhar fechado para não fazer upgrade automático. O Free da Supabase inclui 500 MB de banco, 1 GB de arquivos e 5 GB de egress; ao ultrapassar cotas, não se deve trocar o plano ou desativar spend cap automaticamente. O projeto não usa Supabase Storage para as fotos.

R2 tem franquia mensal de 10 GB-month, 1 milhão de operações Classe A e 10 milhões Classe B no armazenamento Standard. O bucket deve permanecer Standard e privado. Ainda não há bucket R2 neste projeto porque a conta retornou que R2 precisa ser habilitado no Dashboard.

Antes de habilitar uploads ou publicar o backend, configure alertas e fail-closed no provedor, confirme que a conta permanece no plano Free e defina um procedimento de pausa. Limites por requisição reduzem abuso, mas não substituem monitoramento de uso acumulado; por isso a publicação com R2 permanece bloqueada até essa revisão.
