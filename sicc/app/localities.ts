export const LOCALITIES: Record<string, string[]> = {
  "João Pessoa": ["Aeroclube", "Altiplano", "Bancários", "Bairro dos Estados", "Bessa", "Brisamar", "Cabo Branco", "Castelo Branco", "Centro", "Cristo Redentor", "Expedicionários", "Geisel", "Jaguaribe", "Jardim Oceania", "José Américo", "Manaíra", "Mangabeira", "Miramar", "Muçumagro", "Padre Zé", "Penha", "Portal do Sol", "Rangel", "Roger", "São José", "Tambaú", "Tambauzinho", "Torre", "Valentina", "Varadouro"],
  "Campina Grande": ["Alto Branco", "Bairro das Nações", "Bodocongó", "Catolé", "Centro", "Cruzeiro", "Dinamérica", "José Pinheiro", "Liberdade", "Malvinas", "Monte Santo", "Prata", "Sandra Cavalcante", "São José", "Universitário"],
  "Santa Rita": ["Alto das Populares", "Centro", "Marcos Moura", "Municípios", "Popular", "Tibiri", "Várzea Nova"],
  "Bayeux": ["Centro", "Imaculada", "Jardim São Severino", "Mário Andreazza", "Mutirão", "São Bento", "Sesi"],
  "Cabedelo": ["Camalaú", "Centro", "Intermares", "Jacaré", "Poço", "Ponta de Campina", "Renascer"],
  "Natal": ["Alecrim", "Areia Preta", "Barro Vermelho", "Candelária", "Capim Macio", "Cidade Alta", "Cidade da Esperança", "Felipe Camarão", "Igapó", "Lagoa Nova", "Lagoa Seca", "Mãe Luiza", "Neópolis", "Nossa Senhora da Apresentação", "Nova Descoberta", "Pajuçara", "Petrópolis", "Ponta Negra", "Potengi", "Quintas", "Redinha", "Ribeira", "Rocas", "Santos Reis", "Tirol"],
  "Parnamirim": ["Boa Esperança", "Centro", "Cohabinal", "Emaús", "Liberdade", "Monte Castelo", "Nova Parnamirim", "Parque dos Eucaliptos", "Parque Industrial", "Passagem de Areia", "Rosa dos Ventos", "Santos Reis"],
  "Mossoró": ["Abolição", "Aeroporto", "Alto de São Manoel", "Belo Horizonte", "Bom Jardim", "Centro", "Doze Anos", "Ilha de Santa Luzia", "Nova Betânia", "Planalto 13 de Maio", "Santa Delmira", "Santo Antônio", "Vingt Rosado"],
  "São Gonçalo do Amarante": ["Amarante", "Centro", "Golandim", "Guajiru", "Jardim Lola", "Mangabeira", "Regomoleiro", "Santo Antônio"],
  "Macaíba": ["Alfredo Mesquita", "Auta de Souza", "Campo das Mangueiras", "Centro", "Ferreiro Torto", "Lagoa Grande"],
};

export const LOCALITY_CITIES = Object.keys(LOCALITIES);

export const LOCALITY_STATES: Record<string, "PB" | "RN"> = {
  "João Pessoa": "PB",
  "Campina Grande": "PB",
  "Santa Rita": "PB",
  Bayeux: "PB",
  Cabedelo: "PB",
  Natal: "RN",
  Parnamirim: "RN",
  Mossoró: "RN",
  "São Gonçalo do Amarante": "RN",
  Macaíba: "RN",
};
