# Auditoria técnica do SICC

## O que foi verificado

- React 19, Next 16/Vinext, Vite e plugin Cloudflare; entrypoint em
  `worker/index.ts`.
- Bindings D1 (`__SICC_DB`) e R2 (`__SICC_BUCKET`) declarados em
  `.openai/hosting.json`; `vite.config.ts` simula esses bindings localmente.
- API server-side em `app/api`; não é um site estático.
- Drizzle SQLite em `db/schema.ts` e migrations `drizzle/0000...0006`.
  QTC (`qtc_alerts`, `qtc_alert_media`) é criado em runtime e não estava nas
  migrations Drizzle.
- Sessões próprias com cookie HttpOnly/Secure/SameSite=Strict e PBKDF2-SHA256;
  operadores, convites e sessões vivem em D1.
- Fotos em R2; o banco guarda `object_key` e metadados. O cliente comprime
  imagens antes do envio e o servidor valida MIME/tamanho.
- O histórico teve uma fase de hash perceptual. O checkout atual também contém
  `@vladmandic/face-api`: o navegador detecta o maior rosto e gera um descritor
  real de 128 dimensões; a rota D1 calcula distância euclidiana. A tatuagem usa
  assinatura visual aproximada e exige conferência humana.

## Riscos encontrados e tratamento

| Risco | Situação | Tratamento |
| --- | --- | --- |
| Credencial no código | e-mail administrativo pessoal estava constante em `auth.ts` | removido; usar `SICC_ADMIN_EMAIL` no segredo do ambiente |
| Banco sem FK/cascata | SQLite/runtime tinham relacionamentos implícitos | migration PostgreSQL define PK/FK, índices e `on delete` |
| QTC fora da migration | tabelas eram criadas sob demanda | incluídas na migration Supabase |
| Fotos públicas | R2 era protegido pela API, mas não havia modelo de signed URL | bucket R2 privado + validação no servidor + URL curta planejada |
| Privilégio no frontend | aplicação legada usava sessão própria | RLS baseado em `auth.uid()` e perfil servidor no destino |
| Falso reconhecimento | similaridade probabilística pode ser tratada como identidade | manter limiar auditável, revisão humana e auditoria; não confirmar automaticamente |
| Pages estático incompatível | APIs dependem de Worker/D1/R2 | extração para Supabase Functions/Workers é pré-requisito |

Não foram encontrados `.env` reais, chaves privadas, dumps ou uploads
rastreáveis no checkout auditado. Ainda assim, o histórico Git deve ser
revisado antes do push para o GitHub.

## Modelo Supabase preparado

`supabase/migrations/20260906000000_initial_sicc_schema.sql` cobre perfis,
convites, pessoas, endereços, abordagens, objetos apreendidos, mídia, QTCs e
auditoria. Inclui índices, constraints, timestamps UTC e triggers de
`updated_at`. As tabelas guardam somente `object_key` para os arquivos R2.

A migration não cria coluna de hash perceptual. Ela deve armazenar o descritor
facial em pgvector, sem simular resultados; o provedor/modelo, limiar e política
de retenção precisam ser aprovados antes de produção.

O provisionamento de perfis foi bloqueado para clientes autenticados na
segunda migration. Apenas uma Function/Worker servidor, usando a chave
privilegiada fora do navegador, deve criar o primeiro admin ou consumir um
convite de uso único.

## O que não foi executado

O projeto Supabase foi restaurado e as migrations foram aplicadas com sucesso.
O usuário informou que criou `4quarenta/SICC`, porém a conexão GitHub usada pelo
ambiente retorna 404 para esse repositório e não consegue gravar nele. O
Cloudflare Pages ainda não está exposto como uma conexão operacional nesta
sessão. Também não foi feito backfill automático de dados reais.
