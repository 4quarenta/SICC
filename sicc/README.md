# SICC

SICC é uma aplicação mobile-first de cadastro, consulta de pessoas e alertas
operacionais (QTC). Este repositório contém a versão beta atualmente executada
como um Cloudflare Worker privado, com D1/SQLite, R2 e autenticação própria.

## Diagnóstico e decisão de arquitetura

O código real foi auditado antes desta preparação. A stack atual é React 19 +
Next/Vinext + Vite, executada no Worker da Cloudflare. As rotas em `app/api`
dependem diretamente de bindings D1 (`__SICC_DB`) e R2 (`__SICC_BUCKET`), e a
autenticação atual usa sessões próprias e tabelas em D1. Portanto, um deploy
direto do checkout como **Cloudflare Pages estático não funcionaria**: as APIs,
autenticação, banco e arquivos precisam primeiro ser extraídos para Supabase
Auth/Postgres/Storage e Functions/Workers.

Esta entrega prepara a migração sem fingir que contas externas já foram
criadas. O schema reproduzível está em
`supabase/migrations/20260906000000_initial_sicc_schema.sql`; o diagnóstico
detalhado está em [`docs/AUDIT.md`](docs/AUDIT.md). O Worker privado existente
continua sendo o ambiente ativo até a validação do novo backend.

## Desenvolvimento local

Requisitos: Node.js `>=22.13.0`, Linux com `flock`, `curl` e GNU `timeout`.

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Scripts principais:

- `npm run build`: gera e valida o artefato do Worker atual.
- `npm test`: build + teste de metadados/renderização.
- `npm run lint`: lint do projeto.
- `npm run db:generate`: gera migration Drizzle somente para o legado D1.

Não execute `git add .env.local`, arquivos de upload, dumps ou diretórios de
runtime. O `.gitignore` já cobre esses casos.

## Variáveis de ambiente

Copie `.env.example`; os valores reais devem ficar somente no ambiente local,
Cloudflare ou Supabase/Functions. Nunca use uma chave `service_role` em código
executado no navegador.

| Variável | Uso | Onde pode existir |
| --- | --- | --- |
| `APP_URL` | URL pública da aplicação | cliente/servidor |
| `SICC_ADMIN_EMAIL` | e-mail permitido para o bootstrap inicial | segredo do servidor |
| `SICC_BOOTSTRAP_KEY` | chave única para ativar o primeiro admin | segredo do servidor |
| `SUPABASE_URL` | projeto Supabase alvo | cliente/servidor |
| `SUPABASE_PUBLISHABLE_KEY` | chave pública do cliente Supabase | navegador/Functions |
| `SUPABASE_SERVICE_ROLE_KEY` | migração, Auth administrativo e signed URLs | apenas servidor/Edge Function |
| `SUPABASE_STORAGE_BUCKET` | legado; não usado para fotos na arquitetura R2 | servidor |
| `R2_BUCKET_NAME` | bucket privado das fotos | Worker/Pages Function |
| `R2_ENDPOINT` | endpoint S3 compatível do R2 | servidor |
| `R2_ACCESS_KEY_ID` | chave de acesso R2 | segredo do servidor |
| `R2_SECRET_ACCESS_KEY` | segredo de acesso R2 | segredo do servidor |
| `FACE_MATCH_PROVIDER` | `local_face_embedding` no beta; trocar por serviço servidor aprovado na migração | servidor |
| `FACE_MATCH_ENDPOINT` | endpoint do provedor, quando a migração usar um serviço externo | segredo do servidor |

## GitHub privado

1. Crie um repositório **privado** vazio no GitHub.
2. Revise `git status`, `git ls-files` e os arquivos ignorados; confirme que não
   há `.env`, chaves, dumps, fotos ou uploads.
3. Adicione o remoto do GitHub e envie o histórico:

```bash
git remote add github git@github.com:ORGANIZACAO/sicc.git
git push -u github main
```

O remoto interno do Sites não é substituído automaticamente. A criação do
repositório e a configuração da chave SSH/token precisam ser feitas na sua
conta GitHub.

## Supabase

1. Crie um projeto Supabase e guarde a URL e as chaves no gerenciador de
   segredos (não no GitHub).
2. Execute a migration SQL no SQL Editor ou instale o Supabase CLI e use
   `supabase db push`.
3. Habilite apenas os métodos de Auth necessários. O cadastro de operador deve
   ser uma Edge Function/endpoint servidor que valida convite com hash e
   expiração; não confie em campos enviados pelo navegador.
4. Crie um bucket R2 privado. A migration não depende do Storage Supabase:
   grava somente a `object_key`; imagens devem ser acessadas por URL temporária
   assinada pelo servidor, somente após verificar a sessão e a autorização.
5. Faça o backfill dos dados D1 com um script revisado e testado. Não importe
   fotos como Base64 nem para GitHub: envie-as ao Storage e grave apenas
   `object_key` e metadados em `person_media`/`qtc_alert_media`.

O schema habilita RLS em todas as tabelas públicas e usa `auth.uid()`/perfil
servidor para autorização. Nenhuma política usa `user_metadata` como fonte de
privilégio. A tabela de perfil deve ser criada/alterada pela Function de
provisionamento do operador.

## Cloudflare Pages

Pages pode hospedar o frontend após a separação das rotas de servidor. O
checkout atual ainda não tem um output estático funcional: `npm run build`
gera um Worker que depende de D1/R2. Não configure `dist` como Pages output
antes de concluir a extração para Supabase Functions/Workers, pois isso
publicaria uma interface sem login, consulta ou gravação funcionais.

Quando essa extração estiver pronta:

1. Conecte o repositório privado GitHub ao Cloudflare Pages.
2. Configure o comando de build e o diretório de saída definidos pelo novo
   frontend (não invente esses valores a partir do Worker atual).
3. Cadastre somente a publishable key e a URL no frontend; mantenha a
   `service_role` nas Functions/Workers.
4. Configure domínio HTTPS, CORS restrito ao domínio final e fallback SPA para
   as rotas do frontend.

## Similaridade facial e de tatuagem

O checkout atual já contém uma implementação real de similaridade facial: o
modelo local `@vladmandic/face-api` gera um descritor de 128 dimensões no
navegador, e a API ordena candidatos por distância euclidiana. Os modelos são
versionados em `public/models/face-api` e não são um hash de arquivo. A busca de
tatuagem usa uma assinatura visual específica e revisão humana; ela não deve
ser apresentada como identificação biométrica.

Na migração, os descritores faciais devem sair do JSON em D1 e ir para uma
coluna `vector(128)`/índice pgvector no Supabase, com a consulta encapsulada em
Edge Function e limiar auditável. Nenhum resultado deve ser tratado como
confirmação automática de identidade. Antes de uso operacional, valide base
legal, retenção, limiares, revisão humana e residência dos dados.

## Checklist antes do primeiro deploy migrado

- [ ] Repositório GitHub privado criado e sem segredos no histórico.
- [ ] Projeto Supabase criado; migration aplicada e RLS testada com usuário
      operador e admin.
- [ ] Auth de convite implementado em servidor/Edge Function.
- [ ] Bucket privado criado; upload WebP/JPEG comprimido, limites de MIME/tamanho
      e remoção de órfãos verificados.
- [ ] Backfill D1 revisado, com contagem e integridade de PK/FK conferidas.
- [ ] Rotas `app/api` migradas para Functions/Workers; nenhum acesso a D1/R2 ou
      localhost no frontend final.
- [ ] CORS, rate limiting, logs sem dados sensíveis e signed URLs testados.
- [ ] Fluxos de login, cadastro, consulta, edição, exclusão, QTC, filtros,
      fotos, permissões e mobile testados em produção de teste.
- [ ] Descritores faciais migrados para pgvector e busca encapsulada no servidor;
      similaridade de tatuagem validada com revisão humana.
