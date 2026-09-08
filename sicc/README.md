# SICC

SICC é uma aplicação mobile-first de cadastro/consulta de pessoas e alertas
operacionais (QTC). O frontend publicado é uma SPA React/Vite no GitHub Pages.
Dados, autenticação e imagens ficam no Supabase.

## Arquitetura ativa

- GitHub Pages: somente arquivos estáticos gerados por npm run build:pages.
- Supabase Auth: sessão e autenticação dos operadores.
- Supabase Edge Function sicc-api: API autenticada; valida permissões no
  servidor e não expõe a service_role.
- Supabase PostgreSQL: pessoas, operadores, convites, QTCs, auditoria e
  metadados de arquivos.
- Supabase Storage: bucket privado sicc-media; o banco guarda somente
  referências e metadados. URLs de imagem são temporárias/autorizadas.
- Infoseg: parser local leve, sem envio do texto para terceiros. Ele reconhece
  campos por padrões e classifica linhas não estruturais como observações; o
  operador sempre revisa antes de salvar.

O diagnóstico da limpeza está em docs/AUDIT.md. O passo a passo de
Pages/Supabase está em ../docs/GITHUB-PAGES-SUPABASE.md.

## Desenvolvimento local

Requisitos: Node.js 22 ou superior.

    npm install
    cp .env.example .env.local
    npm run dev

Para uma checagem local do TypeScript: npm run typecheck.
Para servir a função localmente, instale o Supabase CLI e use npm run supabase:function:serve.

O build usado em produção é npm run build:pages. Ele gera ../pages-dist, que
é publicado pelo workflow .github/workflows/pages.yml. O workflow não usa
Worker, D1, R2 ou filesystem local.

## Variáveis

As variáveis do navegador começam com VITE_. A chave anon/publishable pode ser
embutida no bundle porque é uma chave pública; RLS e a Edge Function são a
barreira de autorização. SUPABASE_SERVICE_ROLE_KEY e SICC_BOOTSTRAP_KEY são
exclusivamente secrets da Edge Function.

Veja .env.example para a lista completa. Não comite .env.local, fotos,
uploads, dumps ou chaves privadas.

## Supabase

Aplique as migrations em ordem com o SQL Editor ou Supabase CLI. Configure os
secrets da função:

    supabase secrets set \
      SUPABASE_URL=... \
      SUPABASE_ANON_KEY=... \
      SUPABASE_SERVICE_ROLE_KEY=... \
      SICC_STORAGE_BUCKET=sicc-media \
      SICC_ALLOWED_ORIGIN=https://4quarenta.github.io \
      SICC_BOOTSTRAP_KEY=...

O bucket deve permanecer privado. Uploads são comprimidos no navegador antes
do envio; a remoção de cadastro/foto remove também o objeto autorizado no
Storage.

## Segurança e limites conhecidos

- RLS e checagens de papel são aplicados no servidor; o frontend não concede privilégios.
- Uploads passam por validação de tipo/tamanho e não são gravados em Base64 no PostgreSQL.
- Busca facial/tatuagem permanece desabilitada no beta até haver um motor servidor homologado e revisão humana. A dependência e os modelos não fazem parte do bundle ativo; não há resultados simulados.
- O parser do Infoseg é assistência local determinística, não uma identidade automática. Campos e observações devem ser conferidos pelo operador.

## Deploy

1. Configure os secrets da Edge Function e aplique as migrations.
2. Defina no GitHub Actions os valores públicos VITE_SUPABASE_URL,
   VITE_SUPABASE_PUBLISHABLE_KEY e VITE_SICC_API_URL se não quiser usar os
   defaults do bundle.
3. Faça push em main; o workflow constrói e publica o Pages.
4. Teste login, cadastro, edição, exclusões, fotos, convites e QTCs em
   dispositivo móvel.

URL atual: https://4quarenta.github.io/SICC/