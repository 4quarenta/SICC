# GitHub Pages + Supabase

O frontend do SICC é compilado como uma SPA estática em `sicc/pages-dist`. A
API usada pela interface roda na Edge Function `sicc-api` do projeto Supabase
`wsfvpmypmezljeltarhz`. O banco PostgreSQL e o bucket privado `sicc-media`
substituem D1 e R2; nenhuma chave `service_role` é enviada para o navegador.

O workflow `.github/workflows/pages.yml` publica o artefato quando há push em
`main`. O repositório pode continuar privado, mas a disponibilidade do Pages
para repositórios privados depende do plano da conta GitHub. A publicação não
deve tornar o código público como forma de contornar esse requisito.

Para habilitar a primeira conta, configure o segredo `SICC_BOOTSTRAP_KEY` na
Edge Function e use a tela de ativação inicial. Sem esse segredo, a função
responde `bootstrapAllowed: false` de propósito. Depois da primeira conta, os
operadores são criados somente com convites de uso único.

A busca textual, cadastros, vínculos, abordagens, alertas, convites e upload de
fotos usam Supabase. A busca por imagem ainda responde 501 até que o índice de
vetores e o fluxo de revisão humana sejam validados; o frontend mostra essa
indisponibilidade em vez de apresentar resultados não confiáveis.

O build local é:

```bash
cd sicc
npm ci
npm run build:pages
```
