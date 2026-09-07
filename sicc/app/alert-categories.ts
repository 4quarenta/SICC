export type AlertPriority = "extrema" | "alta" | "media" | "baixa";

export type AlertCategory = {
  key: string;
  label: string;
  priority: AlertPriority;
  description: string;
};

export const ALERT_CATEGORIES: AlertCategory[] = [
  { key: "ataque-instituicao-valores", label: "Ataque a Instituição Financeira / Valores", priority: "extrema", description: "Ações contra instituição financeira ou transporte de valores." },
  { key: "risco-a-tropa", label: "Risco à Tropa", priority: "extrema", description: "Situação de ameaça à integridade de policiais ou guarnições." },
  { key: "cerco-bloqueio", label: "Cerco e Bloqueio", priority: "alta", description: "Operação em curso com perímetro, bloqueio ou varredura definida." },
  { key: "desaparecimento-vulneravel", label: "Desaparecimento de Vulnerável", priority: "alta", description: "Desaparecimento de criança, adolescente, idoso ou pessoa vulnerável." },
  { key: "descumprimento-medida-protetiva", label: "Descumprimento de Medida Protetiva", priority: "alta", description: "Violação ou risco de violação de medida protetiva." },
  { key: "suspeito-em-fuga", label: "Suspeito em Fuga", priority: "alta", description: "Autor evadido do local após o fato, com direção ou características conhecidas." },
  { key: "roubo-carga-alto-valor", label: "Roubo de Carga / Bem de Alto Valor", priority: "media", description: "Subtração de carga ou bem de valor elevado." },
  { key: "roubo-furto", label: "Roubo / Furto", priority: "media", description: "Roubo ou furto de pessoa, bem ou objeto, sem enquadramento específico de veículo." },
  { key: "roubo-furto-veiculo", label: "Roubo/Furto de Veículo", priority: "media", description: "Subtração de veículo automotor, com placa e características quando disponíveis." },
  { key: "subtracao-arma-fogo", label: "Subtração de Arma de Fogo", priority: "media", description: "Extravio ou subtração de armamento, munição ou material controlado." },
  { key: "outros", label: "Outros", priority: "media", description: "Ocorrência relevante que não se enquadra nas demais categorias." },
  { key: "pessoa-desaparecida", label: "Pessoa Desaparecida", priority: "media", description: "Pessoa sem paradeiro conhecido, com dados do último avistamento." },
  { key: "foragido-mandado", label: "Foragido / Mandado em Aberto", priority: "baixa", description: "Pessoa procurada pela Justiça ou em descumprimento de medida judicial." },
  { key: "informacao-apuracao", label: "Informação em Apuração", priority: "baixa", description: "Dado ainda não confirmado, de origem diversa, que requer verificação." },
  { key: "atitude-suspeita", label: "Atitude Suspeita", priority: "media", description: "Indivíduo em atitude suspeita para averiguação da guarnição no local informado." },
];

export const ALERT_PRIORITY_LABEL: Record<AlertPriority, string> = {
  extrema: "Extrema",
  alta: "Alta",
  media: "Média",
  baixa: "Baixa",
};

export const ALERT_PRIORITY_ORDER: AlertPriority[] = ["extrema", "alta", "media", "baixa"];
