import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import { PrismaService } from '../../prisma/prisma.service';
import { PartiesService } from './parties.service';
import { CreatePartyDto } from './dto/party.dto';
import { PartyType, VatRegime } from '@prisma/client';

/**
 * Fase 4 — importador CSV de fornecedores (carga inicial a partir do Moloni
 * ou de qualquer export). Colunas mapeáveis: o cliente envia `mapping`
 * (JSON: campo DocFlow → nome da coluna no CSV). Sem mapping, tentam-se
 * cabeçalhos habituais em PT/EN (Moloni: "Nome", "NIF", "Email", ...).
 *
 * Upsert por NIF (PT) ou NIF-IVA (estrangeiro); sem identificador fiscal
 * faz match por nome exato (case-insensitive) e, se não existir, cria.
 * Reusa PartiesService.create/update para manter validações (mod-11,
 * MOD-97, blacklist de IBAN, slug único).
 */
export type PartyImportField =
  | 'name' | 'nif' | 'vatNumber' | 'email' | 'billingEmail' | 'phone' | 'mobile' | 'iban' | 'bic'
  | 'address' | 'city' | 'postalCode' | 'country' | 'paymentTermDays' | 'currency' | 'notes' | 'website';

export type PartyImportMapping = Partial<Record<PartyImportField, string>>;

const DEFAULT_ALIASES: Record<PartyImportField, string[]> = {
  name: ['name', 'nome', 'fornecedor', 'supplier', 'entidade', 'razão social', 'razao social', 'company'],
  nif: ['nif', 'contribuinte', 'nº contribuinte', 'n.º contribuinte', 'vat', 'tax id', 'taxid', 'nipc'],
  vatNumber: ['nif-iva', 'nif iva', 'vat number', 'vatnumber', 'eu vat', 'nif intracomunitario', 'nif intracomunitário'],
  email: ['email', 'e-mail', 'mail'],
  billingEmail: ['email faturação', 'email faturacao', 'billing email', 'email de faturação'],
  phone: ['telefone', 'phone', 'tel', 'telef'],
  mobile: ['telemóvel', 'telemovel', 'mobile', 'cell'],
  iban: ['iban'],
  bic: ['bic', 'swift', 'bic/swift'],
  address: ['morada', 'address', 'endereço', 'endereco', 'rua'],
  city: ['cidade', 'city', 'localidade'],
  postalCode: ['código postal', 'codigo postal', 'cp', 'postal code', 'zip', 'postalcode'],
  country: ['país', 'pais', 'country'],
  paymentTermDays: ['prazo pagamento', 'prazo de pagamento', 'payment terms', 'dias', 'condições pagamento'],
  currency: ['moeda', 'currency'],
  notes: ['notas', 'observações', 'observacoes', 'notes', 'obs'],
  website: ['website', 'site', 'web', 'url'],
};

export interface PartyImportSummary {
  totalRows: number;
  created: number;
  updated: number;
  skipped: number;
  errors: Array<{ row: number; name?: string; error: string }>;
  columnsUsed: Partial<Record<PartyImportField, string>>;
}

function normHeader(h: string): string {
  return h.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

export function resolveMapping(headers: string[], mapping?: PartyImportMapping): Partial<Record<PartyImportField, string>> {
  const out: Partial<Record<PartyImportField, string>> = {};
  const normalised = headers.map((h) => ({ raw: h, n: normHeader(h) }));
  for (const field of Object.keys(DEFAULT_ALIASES) as PartyImportField[]) {
    const wanted = mapping?.[field];
    if (wanted) {
      const hit = normalised.find((h) => h.n === normHeader(wanted));
      if (hit) out[field] = hit.raw;
      continue;
    }
    const aliases = DEFAULT_ALIASES[field].map(normHeader);
    const hit = normalised.find((h) => aliases.includes(h.n));
    if (hit) out[field] = hit.raw;
  }
  return out;
}

export function detectDelimiter(sample: string): ',' | ';' | '\t' {
  const head = sample.split(/\r?\n/)[0] ?? '';
  const counts: Array<[',' | ';' | '\t', number]> = [
    [';', (head.match(/;/g) ?? []).length],
    [',', (head.match(/,/g) ?? []).length],
    ['\t', (head.match(/\t/g) ?? []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

@Injectable()
export class PartyImportService {
  private readonly logger = new Logger(PartyImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly parties: PartiesService,
  ) {}

  async importCsv(
    tenantId: string,
    userId: string,
    buffer: Buffer,
    mapping?: PartyImportMapping,
    opts?: { dryRun?: boolean; type?: PartyType },
  ): Promise<PartyImportSummary> {
    const text = buffer.toString('utf8').replace(/^﻿/, '');
    if (!text.trim()) throw new BadRequestException('CSV vazio');
    let rows: Record<string, string>[];
    try {
      rows = parse(text, {
        columns: true,
        delimiter: detectDelimiter(text),
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
        bom: true,
      }) as Record<string, string>[];
    } catch (err) {
      throw new BadRequestException(`CSV inválido: ${(err as Error).message}`);
    }
    const headers = rows.length ? Object.keys(rows[0]) : [];
    const cols = resolveMapping(headers, mapping);
    if (!cols.name) {
      throw new BadRequestException(
        `Não encontrei a coluna do nome. Cabeçalhos: ${headers.join(', ')}. Use "mapping" para indicar as colunas.`,
      );
    }
    const summary: PartyImportSummary = { totalRows: rows.length, created: 0, updated: 0, skipped: 0, errors: [], columnsUsed: cols };
    const get = (row: Record<string, string>, f: PartyImportField) => {
      const c = cols[f];
      const v = c ? row[c] : undefined;
      return v && v.trim() ? v.trim() : undefined;
    };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const name = get(row, 'name');
      if (!name) {
        summary.skipped++;
        continue;
      }
      try {
        let nif = get(row, 'nif')?.replace(/\s/g, '');
        let vatNumber = get(row, 'vatNumber')?.replace(/[\s.-]/g, '').toUpperCase();
        // Moloni exports foreign VAT ids in the NIF column with the country prefix.
        if (nif && /^[A-Z]{2}[A-Z0-9]{2,13}$/i.test(nif) && !/^\d{9}$/.test(nif)) {
          vatNumber = vatNumber ?? nif.toUpperCase();
          nif = undefined;
        }
        if (nif && /^PT\d{9}$/i.test(nif)) nif = nif.slice(2);
        // Country: explicit column, else the VAT prefix, else PT.
        const countryCol = get(row, 'country')?.toUpperCase().slice(0, 2);
        const vatCountry = vatNumber?.match(/^([A-Z]{2})/)?.[1];
        const country = countryCol ?? vatCountry ?? 'PT';
        const EU = new Set(['AT','BE','BG','CY','CZ','DE','DK','EE','EL','GR','ES','FI','FR','HR','HU','IE','IT','LT','LU','LV','MT','NL','PL','PT','RO','SE','SI','SK','XI']);
        const termsRaw = get(row, 'paymentTermDays');
        const paymentTermDays = termsRaw ? parseInt(termsRaw.replace(/\D/g, ''), 10) : undefined;
        const dto: Partial<CreatePartyDto> & { vatNumber?: string; billingEmail?: string; currency?: string; vatRegime?: VatRegime } = {
          type: opts?.type ?? PartyType.FORNECEDOR,
          name,
          nif,
          vatNumber,
          email: get(row, 'email'),
          billingEmail: get(row, 'billingEmail'),
          phone: get(row, 'phone'),
          mobile: get(row, 'mobile'),
          iban: get(row, 'iban')?.replace(/\s/g, '').toUpperCase(),
          bic: get(row, 'bic'),
          address: get(row, 'address'),
          city: get(row, 'city'),
          postalCode: get(row, 'postalCode'),
          country,
          website: get(row, 'website'),
          notes: get(row, 'notes'),
          currency: get(row, 'currency')?.toUpperCase().slice(0, 3),
          ...(Number.isFinite(paymentTermDays) ? { paymentTermDays } : {}),
          vatRegime: country === 'PT' ? VatRegime.PT : EU.has(country) ? VatRegime.UE_REVERSE_CHARGE : VatRegime.EXTRA_UE,
        };
        Object.keys(dto).forEach((k) => (dto as Record<string, unknown>)[k] === undefined && delete (dto as Record<string, unknown>)[k]);

        const existing = await this.findExisting(tenantId, nif, vatNumber, name);
        if (opts?.dryRun) {
          existing ? summary.updated++ : summary.created++;
          continue;
        }
        if (existing) {
          await this.parties.update(tenantId, userId, existing.id, dto as CreatePartyDto, 'ADMIN');
          summary.updated++;
        } else {
          await this.parties.create(tenantId, userId, dto as CreatePartyDto);
          summary.created++;
        }
      } catch (err) {
        summary.errors.push({ row: i + 2, name, error: (err as Error).message?.slice(0, 200) ?? String(err) });
      }
    }
    this.logger.log(
      `[importCsv] tenant=${tenantId} rows=${summary.totalRows} created=${summary.created} updated=${summary.updated} skipped=${summary.skipped} errors=${summary.errors.length}${opts?.dryRun ? ' (dry-run)' : ''}`,
    );
    return summary;
  }

  private async findExisting(tenantId: string, nif?: string, vatNumber?: string, name?: string) {
    if (nif) {
      const byNif = await this.prisma.party.findFirst({ where: { tenantId, nif }, select: { id: true } });
      if (byNif) return byNif;
    }
    if (vatNumber) {
      const byVat = await this.prisma.party.findFirst({ where: { tenantId, OR: [{ vatNumber }, { nif: vatNumber }] }, select: { id: true } });
      if (byVat) return byVat;
    }
    if (name) {
      return this.prisma.party.findFirst({ where: { tenantId, name: { equals: name, mode: 'insensitive' } }, select: { id: true } });
    }
    return null;
  }
}
