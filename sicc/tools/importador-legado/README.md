# Importador local de acervo legado

## Fase 3: compressao local retomavel

`comprimir-imagens.mjs` exige o OCR concluido e mantem os registros, dados
textuais, estados de revisao, IDs e metadados adicionais do manifest. O padrao
e WebP com teto de 199.000 bytes (abaixo de 200 KB), qualidade inicial 60,
effort 6 e lado maior inicial de ate 1024 pixels, priorizando tamanho menor
mesmo quando o arquivo ja cabe no teto. A qualidade e a resolucao diminuem
automaticamente ate cumprir o limite; nao ha exigencia de preservar legendas.
Quando o WebP fica maior e a origem ja cabe no limite, uma copia byte a byte
do arquivo menor e mantida em `images/` com
`compressionStatus: ORIGINAL_RETAINED`. Nao existe envio remoto nesta fase.

```powershell
node tools/importador-legado/comprimir-imagens.mjs --work C:\caminho\work
# Somente com autorizacao para excluir as copias locais e backup externo:
node tools/importador-legado/comprimir-imagens.mjs --work C:\caminho\work --source-root C:\caminho\extraidos --delete-source
powershell -ExecutionPolicy Bypass -File tools/importador-legado/acompanhar-compressao.ps1 -WorkDir C:\caminho\work
npm run test:compressao
```

Antes do lote, preserve uma copia do checkpoint e do manifest. A exclusao
e individual: verifica SHA-256 da origem, grava a saida com flush e rename,
reabre e decodifica todos os pixels, confere hash/tamanho, salva o vinculo no
SQLite e so entao exclui a origem dentro de `--source-root`. A retomada usa
o mesmo comando, verifica novamente a saida e reaproveita o que esta salvo.
Se uma saida anterior excede o novo limite ou pertence a outro perfil, ela
e recomprimida mesmo quando a origem ja foi removida. A comparacao de tamanho
sempre conserva a alternativa menor; nao se aumenta um arquivo para atingir
200 KB. A chave de perfil evita recomprimir repetidamente na retomada.
Um nome baseado no hash conserva a copia anterior
ate a verificacao e o commit da nova saida; so depois a anterior e removida.
Um lock impede dois compressores no mesmo diretorio de trabalho.

`sourceImagePath` e `sourceSha256` permanecem como rastreabilidade da origem.
Depois da exclusao, use `imageFile` (relativo ao work) ou `currentImagePath`
para abrir a imagem. Pessoas de uma foto coletiva recebem o mesmo vinculo.
O manifest e exportado atomicamente a cada 100 imagens e ao encerrar; durante
a execucao o checkpoint e a fonte mais atualizada. O status e atualizado a
cada imagem. Gravacoes atomicas repetem bloqueios temporarios do Windows;
o monitor permite substituicao durante a leitura (`FileShare.Delete`). Um
bloqueio persistente apenas do status gera aviso e nova tentativa na proxima
imagem, sem abortar o checkpoint. Erros de disco continuam interrompendo.
`COMPRESSAO_CONCLUIDA.txt` so e criado para o lote inteiro sem
erros; um piloto com `--limit` nao conclui a fase e retorna codigo 1 no CLI.
Falhas preservam a origem afetada e ficam em `compressionError` ou
`sourceDeletionError`; a fase de revisao dos dados continua independente.

## Extracao e importacao

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

A versão `caption-v2` usa RapidOCR/ONNX (detector PP-OCRv5 mobile e leitor
latino) na imagem inteira, seguido de Tesseract nos caracteres amarelos
isolados temporariamente do fundo. A posição da legenda não é fixa. As
imagens de origem não são modificadas; máscaras de OCR não são mídia de saída.
Instale `requirements-ocr.txt` em um ambiente Python privado. O primeiro uso
baixa os pesos públicos; a inferência das imagens acontece neste computador.

```powershell
node tools/importador-legado/index.mjs --work C:\caminho\work --extract-full-text --tesseract C:\caminho\tesseract.exe --paddle-python C:\caminho\venv\Scripts\python.exe
```

`--paddle-python` mantém o nome histórico do parâmetro, mas nesta fase inicia
`scene-ocr-worker.py` com RapidOCR. Use só um processo. Registros da versão
antiga são relidos automaticamente; registros concluídos da versão atual são
preservados na retomada. Não repita `--force-full-text` para retomar uma pausa.

`imageText` recebe as linhas selecionadas em ordem de posição. `ocrReadings`
preserva as saídas alternativas; `ocrRegions` registra origem e coordenadas.
Leituras de baixa confiança não entram no texto selecionado, mas permanecem
na alternativa bruta. Espaços internos e quebras retornadas não são
normalizados. `ocrQuality.readable` é uma triagem heurística, não garantia de
transcrição correta. Casos insuficientes permanecem em revisão, mesmo com
CPF sintaticamente válido. A disponibilidade de texto não confirma que uma
imagem contém apenas uma pessoa. Falha do motor pausa o lote, em vez de
marcar milhares de imagens com resultados vazios.

Antes de uma nova estratégia, faça backup local do SQLite. Valide um piloto
com fontes de estilos diferentes e compare as leituras às imagens. Um piloto
de uma única fonte ou apenas legendas amarelas não valida todo o acervo.

O piloto reproduzível não grava no checkpoint: `piloto-ocr.mjs --work ...
--samples ... --python ... --tesseract ...`. A lista privada de amostras é um
array JSON com `recordId` e `sourceImagePath`. Ele gera `comparacao-ocr.html`
com original e transcrição lado a lado, resultados JSON e resumo estatístico
no diretório de trabalho. Não versionar as entradas nem os relatórios.

Imagens com várias pessoas permanecem no mesmo manifest como um registro de
imagem (`recordType: shared_image`, estado `MULTIPLE_PEOPLE`). Este estado
agora indica uma imagem coletiva, não descarte automático. `persons` contém
os registros individuais extraídos dos blocos de texto, cada um com um ID
estável, `parentRecordId`, `sharedImageId`, o mesmo `sourceImagePath` e hash.
Não há cópia, recorte ou identificação facial. Campos no nível da imagem
ficam vazios para evitar que dados de pessoas diferentes sejam misturados.

Rótulos e posição dos blocos delimitam os dados. O nome do arquivo serve como
indício somente quando confirmado pelo OCR. Texto que cruza colunas fica em
`multiPersonUnassignedText`. Cada pessoa tem seu próprio `imageText`, campos
e lista de campos obrigatórios ausentes. As associações propostas ficam em
`REVIEW`, com `associationReviewRequired: true`, antes de liberar cadastro;
CPF válido sozinho não confirma que o bloco foi atribuído corretamente.
Sem dois nomes textuais suficientes, `persons` fica vazio e o OCR completo
permanece disponível para revisão. O merge simples por ID de imagem rejeita
correções individuais para imagens coletivas.

Na retomada, resultados de OCR da versão atual são reaproveitados para
montar `persons`; não é preciso reler nem recomprimir as imagens anteriores.
O checkpoint guarda o payload anterior em `multi_person_history`. O monitor
mostra a quantidade de imagens coletivas e de pessoas extraídas nesses itens.

O `manifest.json` existente é mantido e enriquecido. IDs e metadados adicionais
são preservados. Na retomada, campos que só constam nele são reconciliados com
o checkpoint por ID e hash. Leituras novas vazias não apagam dados anteriores:
`preservedFields` e `fieldEvidence` indicam valores ainda não confirmados e o
registro fica em revisão. Valores substituídos permanecem em
`previousFieldValues`. Nas imagens coletivas, valores antigos sem atribuição
individual segura permanecem em `unassignedExistingFields`, evitando copiar
a mesma filiação ou CPF para todas as pessoas. Registros extras do manifest
não são removidos quando o checkpoint é exportado.

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

## Fase 4 — revisão textual local

`revisar-dados.mjs` usa os textos já salvos no JSON. Não executa OCR, não
decodifica imagens e não escreve em serviços remotos. Confere binários por
tamanho/hash, preserva IDs, textos originais e relações coletivas e gera uma
auditoria com antes/depois. Município/UF usa um cache da API oficial do IBGE.

```powershell
node tools/importador-legado/revisar-dados.mjs --work "C:\caminho\work"
node tools/importador-legado/revisar-dados.mjs --work "C:\caminho\work" --apply
node tools/importador-legado/verificar-fase4.mjs --work "C:\caminho\work"
node tools/importador-legado/gerar-relatorio-fase4.mjs --work "C:\caminho\work"
```

A primeira chamada gera prévia. `--apply` grava as correções no checkpoint
e no manifest existentes, após criar `phase4/before-review` e manter
`phase4_history` no SQLite. A mesma versão já aplicada é rejeitada: novas
revisões devem ser versionadas, sem sobrescrever o snapshot original.

O relatório HTML é local e somente leitura, com busca, filtros, antes/depois,
motivos e OCR. Os resultados são privados; não versionar a pasta `phase4`.

`TEXT_PREPARED` passa apenas pelos bloqueios automáticos de texto, CPF,
duplicidade e mídia. Não confirma identidade ou atualidade. Campos opcionais
inferidos/ambíguos são omitidos da projeção `publication-prepared.json`.
Coletivas, CPFs repetidos e falhas técnicas permanecem pendentes. A publicação
requer conciliar o banco existente e ajustar o mapeamento legado, vínculos
compartilhados e estados desconhecidos. Não usar o importador anterior para
publicar este pacote sem essa adaptação.

Os bytes das imagens são medidos. O crescimento do PostgreSQL é uma estimativa
de planejamento separada; `verificar-cotas-supabase.sql` permite medir o uso
real, somente leitura. Testes: `npm run test:revisao`.

### Revisão aprofundada (v2)

Após aplicar a v1, `aprofundar-revisao.mjs` compara todas as leituras OCR já
salvas de cada imagem individual. Não usa as leituras da raiz para preencher
filhos de uma coletiva. Repara extrações de nomes/CPFs e sinaliza conflitos
entre datas e nomes maternos. Duplicidades compatíveis recebem planos de
unificação com nome/CPF e outra informação pessoal explicitamente apoiada.

```powershell
node tools/importador-legado/aprofundar-revisao.mjs --work "C:\caminho\work"
node tools/importador-legado/aprofundar-revisao.mjs --work "C:\caminho\work" --apply
```

Saídas em `phase4-v2`, incluindo relatório, auditoria, pacote versão 2 e backup
da revisão anterior. O histórico fica em `phase4_deep_history`. A versão já
aplicada não é reaplicada. `--report-only` recria somente o relatório a partir
dos resultados existentes.

O pacote v2 usa `sourceRecordIds`, lista `media` e `associationScopes`.
`TEXT_CONTEXT_PREPARED` indica vínculo textual ao documento inteiro, apoiado
por blocos completos não sobrepostos; não é identificação de um rosto.
`TEXT_LINK_PREPARED` indica proposta de vínculo entre origens compatíveis.
Ambos exigem adaptar o esquema/importador antes de publicar. Nenhum desses
planos apaga registros ou escreve no Supabase. Os totais da v2 substituem os
da v1; a pasta anterior permanece como histórico.

Para dividir a base atual em partes de 300 registros e reconstruí-la:

```powershell
node tools/importador-legado/dividir-manifesto.mjs
node tools/importador-legado/reconstruir-manifesto.mjs
```

Isso cria `manifest-partes-v2/manifest-revisado-part001.json` até
`manifest-revisado-part037.json`, além de
`manifest-revisado-completo.json` e `verificacao.json`. Cada parte mantém
records inteiros, a ordem original e o mesmo conjunto de `recordId`; a última
parte pode ter menos de 300 registros. O script de reconstrução valida as
faixas, não duplica IDs e grava `reconstrucao-verificacao.json`.

### Otimização de mídia para uma futura importação

`otimizar-imagens-upload.mjs` recodifica os WebP válidos em uma pasta separada,
na qualidade 50 e nas dimensões atuais. Cada entrada e saída é verificada por
hash e decodificação; se a nova imagem não for menor, o pacote referencia a
original. O processo é retomável e não remove nem modifica as fontes.

```powershell
node tools/importador-legado/otimizar-imagens-upload.mjs "C:\caminho\work"
node tools/importador-legado/preparar-lote-plataforma.mjs "C:\caminho\work"
node tools/importador-legado/verificar-lote-plataforma.mjs "C:\caminho\work"
```

O segundo comando só roda após a otimização completa. Ele gera
`platform-import-package/candidate-people.json` e `candidate-report.json` sem
acesso remoto. Os candidatos têm CPF único no lote, evidência literal e mídia
verificada. Ainda exigem conciliação com o banco de produção e adaptação do
esquema para estados desconhecidos e imagens sem associação individual. Não
enviar esse pacote diretamente a `/people`: a API atual atribui estados padrão
e classes de mídia que o manifesto não demonstra.

### Acervo completo e importação da plataforma

O pacote do acervo completo preserva os 11.011 registros de origem, compacta as
37 partes corrigidas para um bucket privado e referencia as 10.977 imagens
otimizadas disponíveis. Registros sem nome legível continuam como documentos do
acervo; imagens coletivas usam vínculos textuais separados e nunca viram foto
facial de uma pessoa. Cadastros de pessoa recebem os padrões `alive` e `free`
autorizados pelo usuário. CPF só entra se literal e válido; nome e demais
campos precisam de apoio textual. Conflitos ficam retidos para revisão.
Registros com o mesmo CPF literal válido, nome compatível, mãe e nascimento sem
conflito são ligados ao mesmo cadastro por seus `recordId`; o documento físico
continua separado. O pacote distingue `peopleCandidates`, `linkedDuplicates`
e `heldPeople` para conferir todas as identidades propostas.
O aplicativo oferece consulta paginada ao acervo por nome legível, nome do
arquivo ou `recordId`, inclusive para registros ainda sem cadastro de pessoa.

```powershell
node tools/importador-legado/preparar-importacao-acervo-completo.mjs "C:\caminho\work"
node tools/importador-legado/verificar-importacao-acervo-completo.mjs "C:\caminho\work"
node tools/importador-legado/importar-acervo-completo.mjs "C:\caminho\work"
```

O terceiro comando acima é apenas simulação. Depois de aplicar a migração
`20260919160651_legacy_import_identity_and_documents.sql`, publicar a versão
compatível da função `sicc-api` e configurar `SUPABASE_URL` e
`SUPABASE_SECRET_KEY` somente no ambiente local protegido, acrescente `--apply`
para gravar. Ele valida o projeto, faz upload sem sobrescrever objetos, retoma
pelas chaves estáveis, compara CPFs e nomes existentes, e escreve progresso em
`platform-import-package/import-progress.json`. O segredo não deve entrar no
Git, no relatório nem na interface do navegador.
