# Importador local de acervo legado

O importador processa imagens localmente, usa OCR em português via Tesseract.js e envia somente a imagem WebP comprimida e os metadados validados para o bucket privado do SICC. A chave de serviço é lida apenas do ambiente e nunca é registrada.

O checkpoint SQLite, os relatórios e qualquer staging ficam fora do Git. O lote é idempotente por caminho/hash local e por SHA-256 em `person_media`. Um CPF inválido, dados insuficientes, indício de múltiplas pessoas ou qualquer erro termina em estado rastreável sem interromper os arquivos seguintes.

Exemplos locais (não use valores reais em documentação ou commits):

```powershell
npm run test:importador
node tools/importador-legado/index.mjs --source C:\caminho\staging\legacy-extracted --work C:\caminho\work --url $env:SUPABASE_URL --dry-run --limit 20
node tools/importador-legado/index.mjs --source C:\caminho\staging\legacy-extracted --work C:\caminho\work --url $env:SUPABASE_URL
```

Para separar preparo e envio, execute `--stage-only`. Ele gera em `--work` uma
pasta `images/` com WebPs nomeados pelo `recordId` e um `manifest.json` local
com uma linha por imagem de origem. Cada registro inclui o estado, os campos
extraídos, o ID da imagem e a razão de qualquer bloqueio. Assim, arquivos sem
CPF válido ou com múltiplas pessoas continuam visíveis no listão, mas não ficam
elegíveis para a importação em lote. Esse modo não acessa o Supabase.

Para recuperar campos opcionais de registros já importados sem reenviar a
imagem, use `--repair-fields` com o mesmo diretório de trabalho e checkpoint.
O modo atualiza somente colunas vazias quando o parser local encontra um valor
confiável e registra uma auditoria de correção.

Para reler as imagens originais e adicionar o texto OCR bruto ao manifest sem
comprimir nem acessar o Supabase, use `--extract-full-text`. O modo é
retomável pelo checkpoint e gera `full-text-status.json` e
`review-queue.jsonl` no diretório de trabalho. Use `--limit 20` para um piloto
local antes do lote completo.

Use `--force-full-text` quando o parser tiver sido corrigido e todos os
registros precisarem ser relidos, mesmo os que já possuem `imageText`.

Enquanto o lote estiver executando, acompanhe o progresso em outra janela do
PowerShell. O monitor lê `full-text-status.json`, calcula taxa e previsão e
indica se o processo está ativo, parado parcialmente ou concluído:

```powershell
powershell -ExecutionPolicy Bypass -File "C:\caminho\repository\sicc\tools\importador-legado\acompanhar-full-text.ps1" -WorkDir "C:\caminho\work"
```

O monitor encerra quando `completed=true` ou quando o processo não é mais
localizado. Se o computador for suspenso, o checkpoint permanece preservado e
a execução pode ser retomada com o mesmo comando de extração.

Após a revisão assistida, salve uma linha JSON por correção com `recordId`,
`imageText` e `fields` e aplique-a localmente com:

```powershell
node tools/importador-legado/aplicar-revisao.mjs --work C:\caminho\work --input C:\caminho\revisoes.jsonl
```

Para validar um multipartes RAR, use uma instalação local do 7-Zip/`7z` e o primeiro volume. A validação deve confirmar todos os volumes antes da extração; o importador não executa arquivos extraídos e aceita somente extensões de imagem permitidas.
