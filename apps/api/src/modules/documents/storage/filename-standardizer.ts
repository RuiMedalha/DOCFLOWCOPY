/**
 * filename-standardizer.ts
 *
 * Padronização do nome do ficheiro de faturas e documentos fiscais.
 * Formato: {TIPO}_{FORNECEDOR}_{NUMERO}_{DATA}.pdf
 * Exemplo: FT_NomeFornecedor_FT2026-102_2026-09-09.pdf
 *
 * Siglas oficiais:
 *   - FT: Fatura (FATURA, FATURA_RECEBIDA, etc.)
 *   - FR: Fatura-Recibo (FATURA_RECIBO, FATURA_SIMPLIFICADA)
 *   - NC: Nota de Crédito (NOTA_CREDITO)
 *   - ND: Nota de Débito (NOTA_DEBITO)
 */

export interface StandardFileNameInput {
  type?: string | null;
  supplier?: string | null;
  docNumber?: string | null;
  docDate?: Date | string | null;
  dueDate?: Date | string | null;
  amount?: number | string | null;
  extension?: string | null;
}

/**
 * Mapeia o tipo de documento para a sigla fiscal padronizada.
 */
export function mapDocTypeToSigla(type?: string | null): string {
  if (!type) return 'FT';
  const norm = type.trim().toUpperCase().replace(/[^A-Z_]/g, '');

  if (norm.includes('NOTA_CREDITO') || norm === 'NC') return 'NC';
  if (norm.includes('NOTA_DEBITO') || norm === 'ND') return 'ND';
  if (
    norm.includes('RECIBO') ||
    norm.includes('SIMPLIFICADA') ||
    norm === 'FR' ||
    norm === 'FS'
  ) {
    return 'FR';
  }
  if (norm.includes('FATURA') || norm === 'FT') return 'FT';

  return 'FT';
}

/**
 * Sanitiza o nome do fornecedor para PascalCase / alfanumérico limpo.
 * Ex: "Nome Fornecedor, Lda." -> "NomeFornecedor"
 */
export function sanitizeSupplierForFileName(supplier?: string | null): string {
  if (!supplier || !supplier.trim()) return 'Fornecedor';

  // Remove acentos/diacríticos
  const clean = supplier
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();

  // Converte palavras para PascalCase
  const words = clean
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);

  if (words.length === 0) return 'Fornecedor';

  const pascal = words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');

  return pascal.slice(0, 40) || 'Fornecedor';
}

/**
 * Sanitiza o número do documento para manter caracteres legíveis (letras, dígitos, hífens).
 * Ex: "FT 2026/102" -> "FT2026-102"
 */
export function sanitizeDocNumberForFileName(docNumber?: string | null): string {
  if (!docNumber || !docNumber.trim()) return 'SN';

  const clean = docNumber
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\/\\]+/g, '-')
    .replace(/[^a-zA-Z0-9-_]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  return clean.slice(0, 30) || 'SN';
}

/**
 * Formata a data de emissão para YYYY-MM-DD.
 */
export function formatDateForFileName(dateInput?: Date | string | null): string {
  if (!dateInput) {
    const now = new Date();
    return now.toISOString().slice(0, 10);
  }

  const d = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  if (Number.isNaN(d.getTime())) {
    const now = new Date();
    return now.toISOString().slice(0, 10);
  }

  return d.toISOString().slice(0, 10);
}

/**
 * Gera o nome de ficheiro padronizado no formato:
 * {TIPO}_{FORNECEDOR}_{NUMERO}_{DATA}.pdf
 */
export function generateStandardFileName(input: StandardFileNameInput): string {
  const sigla = mapDocTypeToSigla(input.type);
  const fornecedor = sanitizeSupplierForFileName(input.supplier);
  const numero = sanitizeDocNumberForFileName(input.docNumber);
  const ext = (input.extension ?? 'pdf').replace(/^\.+/, '').toLowerCase() || 'pdf';

  // Convenção oficial da empresa (Fase 4.6 P1):
  // FT_<nº>_<FORNECEDOR>_<valor>EUR_<vencimento:AAAA-MM-DD>.pdf
  if (input.amount !== undefined && input.amount !== null && input.dueDate) {
    const valorNum = typeof input.amount === 'number' ? input.amount : parseFloat(String(input.amount));
    const valorFormatted = !isNaN(valorNum) ? valorNum.toFixed(2) : '0.00';
    const vencimento = formatDateForFileName(input.dueDate);
    return `${sigla}_${numero}_${fornecedor}_${valorFormatted}EUR_${vencimento}.${ext}`;
  }

  const data = formatDateForFileName(input.docDate);
  return `${sigla}_${fornecedor}_${numero}_${data}.${ext}`;
}
