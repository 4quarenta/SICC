# SICC

SICC é uma aplicação mobile-first de cadastro, consulta de pessoas e alertas
operacionais (QTC). A publicação atual usa GitHub Pages para o frontend
estático e uma Supabase Edge Function para a API, com PostgreSQL, Auth e
Storage privado.

## Diagnóstico e decisão de arquitetura

O código real foi auditado antes desta preparação. A interface continua em
React 19 + Next/Vinext + Vite, mas o build do GitHub Pages usa uma entrada Vite
estática em `github-pages/`. A API compatível com os endpoints de `app/api`
foi extraída para `supabase/functions/sicc-api`, com autenticação JWT do
Supabase e Storage privado.

Esta entrega prepara e publica a migração sem fingir que contas externas já
foram criadas. O schema reproduzível está em
`supabase/migrations/20260906000000_initial_sicc_schema.sql`; o diagnóstico
detalhado está em [`docs/AUDIT.md`](docs/AUDIT.md). O guia operacional está em
[`docs/GITHUB-PAGES-SUPABASE.md`](docs/GITHUB-PAGES-SUPABASE.md).

## Desenvolvimento local

Requisitos: Node.js `>=22.13.0`, Linux com `flock`, `curl` e GNU `timeout`.

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Scripts principais:

- `npm run build`: gera e valida o artefato legado do Worker.
- `npm run build:pages`: gera o artefato estático em `../pages-dist` para o GitHub Pages.
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
| `SUPABASE_STORAGE_BUCKET` | bucket privado `sicc-media` | Edge Function |
| `VITE_SUPABASE_URL` | URL do projeto no frontend estático | navegador |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | chave pública do frontend | navegador |
| `VITE_SICC_API_URL` | URL da Edge Function `sicc-api` | navegador |
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
4. A migration cria o bucket privado `sicc-media`; imagens são acessadas por
   URL temporária assinada pela Edge Function, somente após verificar a sessão
   e a autorização.
5. Faça o backfill dos dados D1 com um script revisado e testado. Não importe
   fotos como Base64 nem para GitHub: envie-as ao Storage e grave apenas
   `object_key` e metadados em `person_media`/`qtc_alert_media`.

O schema habilita RLS em todas as tabelas públicas e usa `auth.uid()`/perfil
servidor para autorização. Nenhuma política usa `user_metadata` como fonte de
privilégio. A tabela de perfil deve ser criada/alterada pela Function de
provisionamento do operador.

## GitHub Pages

GitHub Pages hospeda somente o frontend estático. O comando
`npm run build:pages` gera o diretório `pages-dist`; a Edge Function mantém
login, consulta, gravação e arquivos fora do Pages.

Quando essa extração estiver pronta:

1. Habilite GitHub Pages com GitHub Actions no repositório.
2. O workflow `.github/workflows/pages.yml` instala dependências e publica
   `pages-dist` após cada push em `main`.
3. Cadastre somente a publishable key e a URL no frontend; mantenha a
   `service_role` exclusivamente na Edge Function.
4. Configure CORS restrito ao domínio final quando o endereço do Pages estiver
   confirmado. A conta GitHub precisa ter Pages para repositórios privados; não
   torne o código público para contornar essa exigência.

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
