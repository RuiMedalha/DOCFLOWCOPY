/**
 * Fase 4.1 — identidade de fornecedor.
 *
 * O teste real do Rui mostrou o mesmo fornecedor espalhado por várias
 * entidades (SAMMIC, CREATEINFOR). A causa é a cadeia: a IA lê um NIF
 * com um dígito trocado → o NIF não passa o módulo 11 → o resolver não
 * grava NIF nenhum na Party → a procura seguinte por NIF não encontra
 * nada → cria outra Party com o mesmo nome. Em produção ficaram três
 * `CreateInfor` (`nif=null`, `507298608`, `nif=null`).
 *
 * A resolução passa a ter dois níveis:
 *   1. NIF/NIF-IVA **validado** — chave primária de identificação.
 *   2. Sem NIF válido: nome normalizado + país.
 *
 * "Normalizado" = maiúsculas, sem acentos, sem formas jurídicas, sem
 * pontuação, espaços colapsados. Função pura e testada.
 */

/**
 * Formas jurídicas removidas do nome antes de comparar. Cobre PT, ES,
 * IT, FR, DE, UK, NL e as abreviaturas mais comuns nas faturas das
 * amostras (LDA, S.A., S.L., LTD, GMBH, SARL, BV, SRL, S. COOP.).
 */
const LEGAL_FORM_TOKENS = new Set([
  'LDA', 'LTDA', 'SA', 'SAU', 'SL', 'SLU', 'SLL', 'SRL', 'SPA', 'SNC',
  'SAS', 'SARL', 'SASU', 'EURL', 'SCI', 'SCOOP', 'COOP', 'SCA',
  'LTD', 'LIMITED', 'PLC', 'LLP', 'LLC', 'INC', 'CORP', 'CO',
  'GMBH', 'MBH', 'AG', 'KG', 'OHG', 'UG', 'EV',
  'BV', 'NV', 'VOF', 'CV',
  'AS', 'AB', 'OY', 'APS',
  'UNIPESSOAL', 'SOCIEDADE', 'SOC', 'ANONIMA', 'ANONIMO',
  'SOCIEDAD', 'LIMITADA', 'SOCIETA', 'SOCIETE',
  'EMPRESA', 'EMPRESARIAL', 'GROUP', 'GRUPO', 'HOLDING',
]);

/**
 * Nome normalizado para comparação de identidade. Devolve string vazia
 * quando não sobra nada de significativo (ex.: um nome que era só
 * "Lda."), para o chamador saber que não pode usar esta chave.
 */
export function normalizePartyName(name: string | null | undefined): string {
  if (!name) return '';
  const stripped = name
    .normalize('NFD')
    // eslint-disable-next-line no-misleading-character-class
    .replace(/[̀-ͯ]/g, '') // acentos
    .toUpperCase()
    // Abreviaturas pontuadas colapsam num único token ANTES de a
    // pontuação desaparecer: "S.L." → "SL", "S. Coop." → "SCOOP",
    // "S.A." → "SA". Sem isto sobrava "S L" e a forma jurídica passava
    // despercebida, deixando "TEFCOLD ES S L" como nome "normalizado".
    .replace(/\b([A-Z])\.\s*/g, '$1')
    .replace(/&/g, ' E ')
    .replace(/[^A-Z0-9 ]+/g, ' ') // pontuação, incluindo os pontos de "S.L."
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return '';
  const tokens = stripped
    .split(' ')
    .filter((t) => t.length > 0 && !LEGAL_FORM_TOKENS.has(t));
  const out = tokens.join(' ').trim();
  // Só devolvemos a chave quando ela ainda distingue alguma coisa: um
  // resto com menos de 3 caracteres casaria fornecedores diferentes.
  return out.length >= 3 ? out : '';
}

/**
 * Chave de identidade de fornecedor sem NIF validado: nome normalizado
 * + país. Sem país conhecido, a chave não é emitida — casar "SAMMIC"
 * de Espanha com "SAMMIC" de Portugal seria pior do que duplicar.
 */
export function partyNameKey(
  name: string | null | undefined,
  country: string | null | undefined,
): string | null {
  const normalized = normalizePartyName(name);
  const cc = country?.trim().toUpperCase();
  if (!normalized || !cc || !/^[A-Z]{2}$/.test(cc)) return null;
  return `${cc}:${normalized}`;
}

/** True quando os dois nomes designam a mesma entidade comercial. */
export function isSamePartyName(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const na = normalizePartyName(a);
  const nb = normalizePartyName(b);
  return na.length > 0 && na === nb;
}
