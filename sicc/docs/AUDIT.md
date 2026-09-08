# Auditoria e limpeza do SICC

Data da revisão: 2026-09-08

## Stack encontrada

- Frontend ativo: React 19 + Vite, entrada github-pages/static-entry.tsx.
- Build ativo: vite.pages.config.ts, gerando ../pages-dist.
- Publicação: GitHub Actions + GitHub Pages.
- API: Supabase Edge Function sicc-api.
- Banco/autenticação/arquivos: Supabase PostgreSQL, Auth e Storage privado.
- Não há backend local, D1, R2 ou filesystem de uploads no fluxo publicado.

## Limpeza realizada

Removidos por serem artefatos de outra arquitetura e não serem referenciados
pelo build ativo:

- vite.config.ts: configuração antiga Vinext/Cloudflare/Sites, com dependências e
  caminhos inexistentes no projeto atual.
- worker/index.ts: entrypoint antigo de Cloudflare Worker/D1/Image Optimization.
- tests/rendered-html.test.mjs: teste do runtime Worker que não existe mais e
  apontava para dist/server/index.js.
- .npmrc: cache específico do runtime Sites.
- public/file.svg, public/globe.svg e public/window.svg: assets genéricos sem
  referência no frontend.

Também foram removidas referências de Next/Vercel/Worker do tsconfig e do
.gitignore. O modelo de domínio visual foi mantido em public/models/face-api
porque é um asset versionado do fluxo de imagem planejado; a busca permanece
desabilitada e nenhum resultado é simulado.

## Dados e segredos

Não foram encontrados arquivos .env reais, dumps, uploads ou chaves privadas
versionados. As variáveis foram reduzidas ao que a SPA e a Edge Function usam.
A chave anon/publishable do Supabase é pública por desenho; a service_role e a
chave de bootstrap ficam somente nos secrets da Edge Function.

## Parser do Infoseg

Foi adicionado app/infoseg-parser.ts, uma assistência local gratuita e sem
rede externa. Ela reconhece CPF, data, cidade/UF, endereço e nomes por padrões
tolerantes. Linhas adicionais, inclusive observações sem o prefixo 'Obs:', são
preservadas em observações e exibidas com uma indicação de confiança para
revisão humana.

## Itens que permanecem como limitação

- A busca facial/tatuagem está desabilitada até existir motor servidor aprovado,
  limiar auditável e revisão humana.
- A chave pública Supabase ainda possui fallback no bundle para manter a
  publicação atual funcionando; ela não concede privilégios sem RLS.
- A execução da migration e configuração de secrets dependem do projeto
  Supabase conectado.

## Validação necessária após a limpeza

- npm install && npm run build:pages
- login/logout, consulta e cadastro
- edição e exclusão de ficha
- upload/exclusão de fotos
- convites e QTCs
- filtros por cidade/bairro/categoria
- teste em Safari/iOS e Android