import { Injectable, Logger, Optional } from "@nestjs/common";
import { Prisma, PartyType } from "@prisma/client";
import { isValidNif, normalizeNif, normalizeIban } from "@docflow/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { NifLookupService } from "../nif-lookup/nif-lookup.service";
import { ViesProvider } from "../enrichment/providers/vies.provider";
import { normalizePartyName } from "../parties/party-identity";
import { getTenantIdentity } from "../ai/tenant-identity";
import { PartyMergeService } from "../parties/party-merge.service";
import { isGenericPartyName, parsePostalAddress } from "../vies/address-parser";
import { EU_COUNTRY_CODES } from "./field-validation";

/**
 * Inputs the extractor feeds into the supplier auto-resolve step.
 * All fields are optional — the helper is defensive about missing data.
 */
export interface SupplierResolveInput {
  /** Tenant scoping — every query MUST carry this. */
  tenantId: string;
  /** ISO 3166-1 alpha-2 country the supplier operates in (PT for Portuguese suppliers). */
  country?: string;
  /** Supplier display name as extracted (may be undefined). */
  supplierName?: string;
  /** Portuguese NIF (9 digits, mod-11 valid). */
  supplierNif?: string;
  /** Country-prefixed VAT ID for foreign suppliers (e.g. "FR12345678901"). */
  supplierVatId?: string;
  /** Extracted supplier address (street/place). */
  supplierAddress?: string;
  /** Extracted supplier postal code. */
  supplierPostalCode?: string;
  /** Extracted supplier city. */
  supplierCity?: string;
  /** Extracted supplier phone number. */
  supplierPhone?: string;
  /** Extracted supplier email. */
  supplierEmail?: string;
  /** Extracted supplier website. */
  supplierWebsite?: string;
  /** IBAN from the document. Carried into the Party row when we create one. */
  iban?: string;
  /** AI-reported confidence (0..1). Below 0.8 → supplierReview = true. */
  aiConfidence?: number;
  /** Suggested expense category from document AI (e.g. "62.2.6 Conservação"). */
  suggestedCategory?: string;
}

/**
 * Result the helper hands back to processDocumentAsync. The Document row
 * is updated with `document.partyId` + `metadata.supplierReview` based on
 * these fields. `party` is the Prisma row the helper decided on (used by
 * downstream code to decide whether to fire the recurring threshold).
 */
export interface SupplierResolveResult {
  /** Resolved Party row (existing or newly created). null on failure. */
  party: { id: string; isRecurring: boolean; name?: string } | null;
  /**
   * Whether the document needs the user to confirm the supplier.
   * True when the AI confidence was low (< 0.8) OR the NIF/VAT was
   * invalid. The UI surfaces this as a "needs review" badge.
   */
  supplierReview: boolean;
  /** Free-form reason for the audit trail / metadata. */
  reason: string;
}

/**
 * SupplierResolver — auto-links (or creates + links) the Party record
 * for an extracted supplier.
 *
 * Rules (user-approved, see docs/FOREIGN_INVOICE_FLOW.md):
 *   - Every supplier gets a Party record (always created if missing).
 *   - Look up by (tenantId, nif OR vatId, country). When the country is
 *     missing we fall back to a tenantId+nif lookup; foreign VATs are
 *     inherently country-prefixed so country is always present there.
 *   - Confidence gate: aiConfidence > 0.8 AND the NIF/VAT validates
 *     (PT NIF mod-11, EU VAT shape) → create + link silently. Below
 *     that threshold → still create the Party but flag
 *     supplierReview on the document metadata so the UI can prompt the
 *     user to confirm.
 *   - Recurring flag: when the supplier already has >= 3 documents
 *     linked, flip `isRecurring = true`. Read-then-write is fine here
 *     because two parallel uploads of the same supplier may both
 *     bump the flag — set is idempotent at the column level.
 *   - NEVER blocks / crashes the upload. All DB errors are caught,
 *     logged, and converted to `{ party: null, supplierReview: true }`
 *     so the document row + extraction metadata still get written.
 *
 * Kept separate from extraction.service.ts so:
 *   1) the unit tests can exercise it without spinning up the full
 *      extraction pipeline, and
 *   2) folder-rules work (in a parallel pane) reads its result without
 *      a circular import on the main service.
 */
@Injectable()
export class SupplierResolver {
  private readonly logger = new Logger(SupplierResolver.name);

  /** Threshold of documents a supplier needs to be flagged recurring. */
  static readonly RECURRING_THRESHOLD = 3;
  /** Confidence floor — below this, supplierReview is set. */
  static readonly CONFIDENCE_FLOOR = 0.8;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly nifLookup?: NifLookupService,
    @Optional() private readonly viesProvider?: ViesProvider,
    @Optional() private readonly partyMerge?: PartyMergeService,
  ) {}

  /**
   * Resolve + link the supplier for a Document extraction.
   * Always returns a result; failure paths return null party + review=true.
   *
   * The `pendingDocument` argument tells the resolver that the caller
   * (processDocumentAsync) WILL create one more Document row linked to
   * the resolved party in the same flow. We use it to bump the recurring
   * threshold against the count *after* the link, not before — so the
   * third upload crossing the threshold actually flips isRecurring on
   * its own resolution.
   */
  async resolve(input: SupplierResolveInput): Promise<SupplierResolveResult> {
    const {
      tenantId,
      country,
      supplierName,
      supplierNif,
      supplierVatId,
      iban,
      aiConfidence,
      supplierAddress,
      supplierPostalCode,
      supplierCity,
      supplierPhone,
      supplierEmail,
      supplierWebsite,
    } = input;

    try {
      // ── Fase 4.2 (P0.1) — invariante duro: nunca criamos um Party
      // FORNECEDOR com o NIF do próprio tenant. Isto é defesa em
      // profundidade: `ensureSupplierCustomerSanity` já trata a maior
      // parte dos casos a montante, mas esta é a última linha antes de
      // escrever na base — se algum caminho novo (ou um bug futuro)
      // deixar passar o nosso próprio NIF como "fornecedor", é aqui que
      // paramos, sempre, independentemente da origem do valor.
      const tenantGuardNif = supplierNif ? normalizeNif(supplierNif) : "";
      if (tenantGuardNif) {
        const identity = await getTenantIdentity(this.prisma, tenantId).catch(() => null);
        const ownNif = identity ? normalizeNif(identity.tenantNif) : "";
        if (ownNif && tenantGuardNif === ownNif) {
          this.logger.error(
            `[resolve] BLOQUEADO: tentativa de criar/ligar um fornecedor com o NIF do ` +
              `próprio tenant (${ownNif}) para tenant=${tenantId}. supplierName="${supplierName ?? "?"}". ` +
              `Isto nunca é válido — o emitente é sempre a OUTRA entidade do documento.`,
          );
          return {
            party: null,
            supplierReview: true,
            reason: "blocked_tenant_nif_as_supplier",
          };
        }
      }

      const normalizedNif = supplierNif ? normalizeNif(supplierNif) : "";
      // Country-prefixed VAT (e.g. "FR123...") wins over a bare NIF when
      // both are present — foreign invoices carry the VAT on the row.
      const normalizedVat = supplierVatId
        ? supplierVatId.replace(/\s+/g, "").toUpperCase()
        : "";
      const countryCode = (country || (normalizedVat ? normalizedVat.slice(0, 2) : "PT")).toUpperCase();

      const taxIdValid = this.isTaxIdValid(countryCode, normalizedNif, normalizedVat);

      // Foreign VATs are stored in the `nif` column with their country
      // prefix so future lookups can match on (nif + country). PT NIFs
      // are stored as the bare 9-digit string.
      // Fase 4.1 — nada de identificadores não validados na Party. Um
      // NIF-IVA estrangeiro só se torna a identidade do fornecedor
      // depois de o VIES o confirmar (ver `viesConfirmed` abaixo); até
      // lá fica em `vatNumber` como texto não validado e a identidade é
      // o nome normalizado + país.
      let taxIdToStore =
        countryCode === "PT"
          ? taxIdValid
            ? normalizedNif
            : null
          : null;

      // Look up by NIF (PT) OR VAT (foreign). Tenant scoping is mandatory.
      const existing = await this.lookupParty({
        tenantId,
        // Só procuramos por NIF quando ele é válido — procurar por um
        // NIF que falhou o módulo 11 é procurar por lixo.
        nif: taxIdValid ? normalizedNif || null : null,
        vatId: taxIdValid ? normalizedVat || null : null,
        country: countryCode,
        name: supplierName,
        iban: iban && this.isIbanValid(iban) ? normalizeIban(iban) : null,
      });

      const confidenceOk = (aiConfidence ?? 0) > SupplierResolver.CONFIDENCE_FLOOR;
      // PT NIFs are validated with mod-11; foreign VATs use shape rules
      // (`findForeignVatId` in extraction.service.ts already vetted them,
      // but we re-check so the helper is safe to call directly).
      const supplierReview = !(confidenceOk && taxIdValid);

      // Consulta imediata aos serviços oficiais (nif-lookup para PT / VIES para comunitário)
      const officialData = await this.queryOfficialData({
        tenantId,
        countryCode,
        normalizedNif,
        normalizedVat,
        taxIdValid,
        iban,
      });

      // Para fornecedores comunitários, o VIES confirmou a inscrição
      // sempre que devolveu dados oficiais (`source === 'vies'`).
      const viesConfirmed =
        countryCode !== "PT" && Boolean(normalizedVat) && officialData?.source === "vies";
      if (viesConfirmed) {
        taxIdToStore = normalizedVat;
      }

      let partyRow: { id: string; isRecurring: boolean; name: string; nif: string | null; address?: string | null; city?: string | null; postalCode?: string | null; country?: string | null } | null = existing;

      // P0.4 — Quando a entidade existente não tem NIF e o documento traz um NIF válido:
      // 1) Verificar se já existe outra entidade com esse NIF no mesmo tenant.
      //    Se sim, fundir a entidade sem NIF na entidade com NIF (a com NIF é o destino).
      // 2) Se não existir outra, atualizar o NIF da existente.
      if (partyRow && !partyRow.nif && taxIdValid && (normalizedNif || (viesConfirmed && normalizedVat))) {
        const targetTaxId = normalizedNif || normalizedVat;
        const otherPartyWithNif = await this.prisma.party.findFirst({
          where: {
            tenantId,
            isActive: true,
            OR: [
              { nif: targetTaxId },
              { vatNumber: targetTaxId },
            ],
            NOT: { id: partyRow.id },
          },
          select: { id: true, name: true, nif: true, isRecurring: true, address: true, city: true, postalCode: true, country: true },
        });

        if (otherPartyWithNif) {
          this.logger.log(
            `[resolve] P0.4 auto-merge: existing party=${partyRow.id} ("${partyRow.name}", no NIF) ` +
            `matches partyWithNif=${otherPartyWithNif.id} ("${otherPartyWithNif.name}", NIF ${targetTaxId}). Merging...`
          );
          if (this.partyMerge) {
            try {
              await this.partyMerge.merge(tenantId, 'system', otherPartyWithNif.id, partyRow.id);
            } catch (mergeErr) {
              this.logger.warn(`[resolve] auto-merge failed: ${(mergeErr as Error).message}`);
            }
          }
          partyRow = otherPartyWithNif;
        } else {
          // Atualiza NIF da existente
          try {
            await this.prisma.party.update({
              where: { id: partyRow.id },
              data: {
                nif: targetTaxId,
                ...(viesConfirmed && normalizedVat ? { vatNumber: normalizedVat, viesValid: true, viesValidatedAt: new Date(), vatRegime: 'UE_REVERSE_CHARGE' } : {}),
              },
            });
            partyRow.nif = targetTaxId;
          } catch (updateErr) {
            this.logger.warn(`[resolve] failed to update NIF on party=${partyRow.id}: ${(updateErr as Error).message}`);
          }
        }
      }


      if (!partyRow) {
        // Create the Party row. Preenchemos com os dados oficiais validados caso obtidos,
        // ou fallback para o nome extraído.
        const ibanToStore = iban && this.isIbanValid(iban) ? normalizeIban(iban) : null;
        const validOfficial =
          officialData?.officialName && !isGenericPartyName(officialData.officialName)
            ? officialData.officialName.trim().slice(0, 200)
            : null;
        const validSupplier =
          supplierName && !isGenericPartyName(supplierName)
            ? supplierName.trim().slice(0, 200)
            : null;
        const nameToStore = validOfficial || validSupplier || "Fornecedor por identificar";


        const isEu = countryCode !== "PT" && EU_COUNTRY_CODES.has(countryCode);
        const defaultVatRegime = countryCode === "PT" ? "PT" : (isEu ? "UE_REVERSE_CHARGE" : "EXTRA_UE");
        const defaultCategoryId = input.suggestedCategory ? await this.matchCategory(tenantId, input.suggestedCategory) : null;

        try {
          partyRow = await this.prisma.party.create({
            data: {
              tenantId,
              type: PartyType.FORNECEDOR,
              name: nameToStore,
              nif: taxIdToStore,
              // Texto não validado fica visível como tal: `vatNumber`
              // com `viesValid` a dizer a verdade sobre ele.
              ...(normalizedVat && countryCode !== "PT"
                ? { vatNumber: normalizedVat, viesValid: viesConfirmed ? true : null }
                : {}),
              vatRegime: (viesConfirmed ? "UE_REVERSE_CHARGE" : defaultVatRegime) as any,
              ...(defaultCategoryId ? { defaultCategoryId } : {}),
              iban: ibanToStore,
              address: (officialData?.address && !/^[-–—\s/.]+$/.test(officialData.address.trim()) ? officialData.address.trim() : null) ?? supplierAddress ?? null,
              city: officialData?.city ?? supplierCity ?? null,
              postalCode: officialData?.postalCode ?? supplierPostalCode ?? null,
              country: officialData?.country ?? countryCode,
              phone: supplierPhone ?? null,
              email: supplierEmail ?? null,
              website: supplierWebsite ?? null,
              enrichedAt: officialData?.source ? new Date() : null,
              enrichmentSource: officialData?.source ?? null,
              isActive: true,
            },
            select: { id: true, name: true, nif: true, isRecurring: true, address: true, city: true, postalCode: true, country: true, vatRegime: true, defaultCategoryId: true },
          });
        } catch (err) {
          // Race with a parallel upload that just created the same row —
          // re-read by tax-id + tenant and use that one. Anything else
          // is a hard failure → log + return null party so the caller
          // proceeds without linking.
          const raced = await this.lookupParty({
            tenantId,
            nif: countryCode === "PT" ? taxIdToStore : null,
            vatId: countryCode !== "PT" ? normalizedVat : null,
            country: countryCode,
            name: supplierName,
          });
          if (raced) {
            partyRow = raced;
          } else {
            this.logger.warn(
              `[resolve] could not create party for tenant=${tenantId} ` +
                `vat=${normalizedVat} nif=${normalizedNif}: ${(err as Error).message}`,
            );
            return {
              party: null,
              supplierReview: true,
              reason: `party_create_failed:${(err as Error).message?.slice(0, 120)}`,
            };
          }
        }
      } else if (partyRow) {
        // Se a entidade já existir, atualizar os campos vazios ou enriquecer com os dados oficiais validados
        try {
          const updates: Record<string, any> = {};
          // ── Fase 4.1 — o VIES tem de ficar registado na entidade ────
          // As entidades criadas antes desta fase guardavam o NIF-IVA na
          // coluna `nif` sem qualquer prova, e ficavam com `viesValid`
          // nulo e regime PT — o que tornava impossível verificar que o
          // identificador tinha sido validado. Quando o VIES confirma,
          // gravamos a prova na própria entidade.
          if (viesConfirmed && normalizedVat) {
            if (partyRow.nif !== normalizedVat) updates.nif = normalizedVat;
            updates.vatNumber = normalizedVat;
            updates.viesValid = true;
            updates.viesValidatedAt = new Date();
            updates.vatRegime = 'UE_REVERSE_CHARGE';
          } else if ((partyRow as any).country !== 'PT' && (partyRow as any).vatRegime === 'PT') {
            const isEu = EU_COUNTRY_CODES.has((partyRow as any).country ?? countryCode);
            updates.vatRegime = isEu ? 'UE_REVERSE_CHARGE' : 'EXTRA_UE';
          }
          if (!(partyRow as any).defaultCategoryId && input.suggestedCategory) {
            const matchedCat = await this.matchCategory(tenantId, input.suggestedCategory);
            if (matchedCat) updates.defaultCategoryId = matchedCat;
          }
          const cleanOfficialAddress = officialData?.address && !/^[-–—\s/.]+$/.test(officialData.address.trim()) ? officialData.address.trim() : null;
          const candidateAddress = cleanOfficialAddress || supplierAddress;
          if ((!partyRow.address || /^[-–—\s/.]+$/.test(partyRow.address.trim())) && candidateAddress) {
            updates.address = candidateAddress;
          }
          const candidateCity = officialData?.city || supplierCity;
          if (!partyRow.city && candidateCity) {
            updates.city = candidateCity;
          }
          const candidatePostalCode = officialData?.postalCode || supplierPostalCode;
          if (!partyRow.postalCode && candidatePostalCode) {
            updates.postalCode = candidatePostalCode;
          }
          if (!(partyRow as any).phone && supplierPhone) {
            updates.phone = supplierPhone;
          }
          if (!(partyRow as any).email && supplierEmail) {
            updates.email = supplierEmail;
          }
          if (!(partyRow as any).website && supplierWebsite) {
            updates.website = supplierWebsite;
          }
          if (officialData && (!partyRow.country || partyRow.country === 'PT') && officialData.country) {
            updates.country = officialData.country;
          }
          if (
            (officialData?.officialName || supplierName) &&
            isGenericPartyName(partyRow.name, partyRow.nif, (partyRow as any).vatNumber)
          ) {
            const candidate =
              (officialData?.officialName && !isGenericPartyName(officialData.officialName)
                ? officialData.officialName.trim().slice(0, 200)
                : null) ||
              (supplierName && !isGenericPartyName(supplierName)
                ? supplierName.trim().slice(0, 200)
                : null);
            if (candidate) {
              updates.name = candidate;
              partyRow.name = candidate;
            }
          }
          if (officialData?.source) {
            updates.enrichedAt = new Date();
            updates.enrichmentSource = officialData.source;
            updates.enrichmentError = null;
          }
          if (Object.keys(updates).length > 0) {
            await this.prisma.party.update({
              where: { id: partyRow.id },
              data: updates,
            });
            this.logger.log(
              `[resolve] enriched existing party=${partyRow.id} with fields: ${Object.keys(updates).join(', ')}`,
            );
          }
        } catch (updateErr) {
          this.logger.warn(`[resolve] failed to update existing party=${partyRow.id}: ${(updateErr as Error).message}`);
        }
      }

      // Recurring threshold — read tenant's documents for this party,
      // bump isRecurring when count crosses the floor. We add `+1`
      // because the caller WILL create one more Document row linked to
      // this party in the same flow (the resolution runs BEFORE the
      // Document write). Cheap because the (tenantId, partyId) index on
      // documents makes this a bounded scan.
      const isRecurring = await this.refreshRecurringFlag(tenantId, partyRow.id, 1);

      return {
        party: { id: partyRow.id, isRecurring, name: partyRow.name },
        supplierReview,
        reason: existing ? "found" : supplierReview ? "created_review" : "created",
      };
    } catch (err) {
      // Never let the supplier step abort extraction. Log + degrade to
      // null party + review=true; the document row is still saved.
      this.logger.warn(
        `[resolve] unexpected failure for tenant=${input.tenantId}: ${(err as Error).message}`,
      );
      this.logger.debug(`[resolve] stack: ${(err as Error).stack ?? "(none)"}`);
      return {
        party: null,
        supplierReview: true,
        reason: `resolve_threw:${(err as Error).message?.slice(0, 120)}`,
      };
    }
  }

  /**
   * Look up a Party by tenantId + (nif OR vatId, country). Returns null
   * when nothing matches. Country matching is required for VAT-based
   * lookups (a PT NIF won't collide with a FR VAT), optional for
   * PT NIFs (we treat the country as PT).
   */
  private async lookupParty(args: {
    tenantId: string;
    nif: string | null;
    vatId: string | null;
    country: string;
    /**
     * Fase 4.1 — nome extraído, para o fallback por nome normalizado
     * quando não há NIF validado. Sem isto, um NIF mal lido pela IA
     * criava uma Party nova a cada documento (três `CreateInfor` em
     * produção).
     */
    name?: string | null;
    /**
     * Fase 4.2 (P0.4.5) — último recurso, depois do NIF validado e do
     * nome normalizado: um IBAN já visto identifica a mesma entidade
     * mesmo quando o nome varia entre faturas.
     */
    iban?: string | null;
  }): Promise<{ id: string; name: string; nif: string | null; isRecurring: boolean; address?: string | null; city?: string | null; postalCode?: string | null; country?: string | null; vatRegime?: string | null; defaultCategoryId?: string | null } | null> {
    const { tenantId, nif, vatId, country, name, iban } = args;

    // Prefer NIF lookup (most common in PT).
    if (nif) {
      const byNif = await this.prisma.party.findFirst({
        where: { tenantId, nif },
        select: { id: true, name: true, nif: true, isRecurring: true, address: true, city: true, postalCode: true, country: true, vatRegime: true, defaultCategoryId: true },
      });
      if (byNif) return byNif as any;
    }

    // Fall back to VAT — store the country-prefixed VAT as the `nif`
    // column for foreign suppliers (the schema doesn't have a dedicated
    // vatId column; the leading 2-letter prefix lets us reconstruct it).
    if (vatId && vatId.slice(0, 2) === country) {
      const byVat = await this.prisma.party.findFirst({
        where: { tenantId, OR: [{ nif: vatId }, { vatNumber: vatId }], country },
        select: { id: true, name: true, nif: true, isRecurring: true, address: true, city: true, postalCode: true, country: true, vatRegime: true, defaultCategoryId: true },
      });
      if (byVat) return byVat as any;
    }

    // Final fallback: search by country + partial VAT prefix (covers the
    // case where the row was stored without the country-prefix normalization).
    if (vatId && vatId.length >= 4) {
      const byPrefix = await this.prisma.party.findFirst({
        where: { tenantId, country, OR: [{ nif: { contains: vatId.slice(2) } }, { vatNumber: { contains: vatId.slice(2) } }] },
        select: { id: true, name: true, nif: true, isRecurring: true, address: true, city: true, postalCode: true, country: true, vatRegime: true, defaultCategoryId: true },
      });
      if (byPrefix) return byPrefix as any;
    }

    // ── Fase 4.1 — fallback por nome normalizado + país ──────────────
    // Sem NIF validado, a identidade é o nome normalizado (maiúsculas,
    // sem acentos, sem formas jurídicas LDA/SA/S.L./LTD/GMBH, sem
    // pontuação) mais o país. Fazemos o filtro de nome em memória
    // porque a normalização (remoção de formas jurídicas) não tem
    // equivalente em SQL — o conjunto por tenant+país é pequeno.
    const normalized = normalizePartyName(name);
    if (normalized) {
      try {
        const candidates = await this.prisma.party.findMany({
          where: { tenantId, country, type: PartyType.FORNECEDOR },
          select: { id: true, name: true, nif: true, isRecurring: true, address: true, city: true, postalCode: true, country: true, vatRegime: true, defaultCategoryId: true },
          orderBy: { createdAt: "asc" },
          take: 500,
        });
        // Preferimos a Party que já tem NIF — é a que sobrevive à fusão.
        const matches = candidates.filter((c) => normalizePartyName(c.name) === normalized);
        const byName = matches.find((c) => c.nif) ?? matches[0];
        if (byName) {
          this.logger.log(
            `[lookupParty] matched party=${byName.id} by normalized name ` +
              `"${normalized}" (${country}) — no validated tax id available`,
          );
          return byName as any;
        }
      } catch (err) {
        // O fallback por nome é um extra: se falhar, seguimos para a
        // criação de uma Party nova em vez de abortar a resolução.
        this.logger.warn(
          `[lookupParty] name fallback failed for "${normalized}": ${(err as Error).message}`,
        );
      }
    }

    // ── Fase 4.2 (P0.4.5) — último recurso: IBAN já conhecido ────────
    // Sem NIF válido e sem nome que normalize para algo reconhecível
    // (ex.: uma fatura com o nome mal OCR'd), um IBAN que já apareceu
    // noutra fatura deste tenant é o último sinal fiável de que é a
    // mesma entidade.
    if (iban) {
      try {
        const byIban = await this.prisma.party.findFirst({
          where: { tenantId, iban, type: PartyType.FORNECEDOR },
          select: { id: true, name: true, nif: true, isRecurring: true, address: true, city: true, postalCode: true, country: true, vatRegime: true, defaultCategoryId: true },
        });
        if (byIban) {
          this.logger.log(
            `[lookupParty] matched party=${byIban.id} by known IBAN ${iban} — ` +
              `sem NIF nem nome reconhecível`,
          );
          return byIban as any;
        }
      } catch (err) {
        this.logger.warn(`[lookupParty] IBAN fallback failed: ${(err as Error).message}`);
      }
    }

    return null;
  }

  /**
   * Refresh the recurring flag based on the supplier's document count.
   * `pendingDocuments` is the number of documents the caller is about to
   * write in the same flow — included in the threshold check so the
   * third upload crossing the threshold flips the flag on its own call.
   * Idempotent — flipping a true → true write is a no-op.
   */
  private async refreshRecurringFlag(
    tenantId: string,
    partyId: string,
    pendingDocuments = 0,
  ): Promise<boolean> {
    try {
      const docCount = await this.prisma.document.count({
        where: { tenantId, partyId },
      });
      const shouldRecur =
        docCount + pendingDocuments >= SupplierResolver.RECURRING_THRESHOLD;

      // Security fix (audit §3 TOCTOU): do NOT read-then-write — use a
      // conditional updateMany keyed on `isRecurringManualOverride: false`.
      // The DB applies the where clause + write atomically, so an ADMIN
      // flipping the override on between our SELECT and UPDATE is
      // respected: count=0 means "override just got enabled (or party
      // gone) — do nothing". updateMany returns the count of rows that
      // matched AND were written (==1 in the success case, 0 otherwise).
      if (shouldRecur) {
        await this.prisma.party.updateMany({
          where: { id: partyId, isRecurringManualOverride: false },
          data: { isRecurring: true },
        });
      }

      // Read the post-image purely to return the CURRENT value to the
      // caller — never to decide anything. If the override was just
      // enabled, isRecurringManualOverride will be true and isRecurring
      // stays whatever the ADMIN decided; we surface that as the result.
      const party = await this.prisma.party.findFirst({
        where: { id: partyId },
        select: { isRecurring: true, isRecurringManualOverride: true },
      });
      if (party?.isRecurringManualOverride === true) {
        return party.isRecurring;
      }
      return shouldRecur;
    } catch (err) {
      this.logger.warn(
        `[resolve] could not refresh isRecurring for party=${partyId}: ${(err as Error).message}`,
      );
      return false;
    }
  }

  /**
   * Validate a tax ID based on the issuing country. PT uses mod-11
   * via the shared util; foreign VATs use the same VIES shape regex
   * extraction.service.ts already vetted.
   */
  private isTaxIdValid(country: string, nif: string, vatId: string): boolean {
    if (country === "PT") {
      return !!nif && isValidNif(nif);
    }
    if (vatId) {
      // Reuse the same VIES shape regex from extraction.service.ts via
      // a tiny inline copy — keeps this helper self-contained and the
      // behaviour identical to the extraction step's check.
      return /^[A-Z]{2}[A-Z0-9]{2,12}$/.test(vatId) && this.viesShapeMatches(vatId);
    }
    return false;
  }

  /** Same regex table as `findForeignVatId` in extraction.service.ts. */
  private viesShapeMatches(vatId: string): boolean {
    const patterns: Record<string, RegExp> = {
      AT: /^ATU\d{8}$/,
      BE: /^BE\d{10}$/,
      BG: /^BG\d{9,10}$/,
      CY: /^CY\d{8}[A-Z]$/,
      CZ: /^CZ\d{8,10}$/,
      DE: /^DE\d{9}$/,
      DK: /^DK\d{8}$/,
      EE: /^EE\d{9}$/,
      ES: /^ES[A-Z0-9]\d{7}[A-Z0-9]$/,
      FI: /^FI\d{8}$/,
      FR: /^FR[A-Z0-9]{2}\d{9}$/,
      GR: /^(?:GR|EL)\d{9}$/,
      HR: /^HR\d{11}$/,
      HU: /^HU\d{8}$/,
      IE: /^IE\d{7}[A-Z0-9]{1,2}$/,
      IT: /^IT\d{11}$/,
      LT: /^LT(?:\d{9}|\d{12})$/,
      LU: /^LU\d{8}$/,
      LV: /^LV\d{11}$/,
      MT: /^MT\d{8}$/,
      NL: /^NL\d{9}B\d{2}$/,
      PL: /^PL\d{10}$/,
      RO: /^RO\d{2,10}$/,
      SE: /^SE\d{12}$/,
      SI: /^SI\d{8}$/,
      SK: /^SK\d{10}$/,
      GB: /^GB(?:\d{9}|\d{12}|GD\d{3}|HA\d{3})$/,
    };
    const country = vatId.slice(0, 2) === "EL" ? "GR" : vatId.slice(0, 2);
    return patterns[country]?.test(vatId) ?? false;
  }

  private isIbanValid(iban: string): boolean {
    try {
      // normalizeIban strips separators; the strict validator is the
      // MOD-97 check. Don't import the whole shared package here for
      // one symbol — call it via the extraction service's already-imported
      // helpers via the PrismaService caller. Keep this defensive so a
      // malformed IBAN never blocks the Party row.
      const cleaned = iban.replace(/\s+/g, "").toUpperCase();
      // Cheap shape check first; full MOD-97 below.
      if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(cleaned)) return false;
      // Re-arrange: move first 4 chars to the end + replace letters.
      const rearranged = cleaned.slice(4) + cleaned.slice(0, 4);
      let numeric = "";
      for (const ch of rearranged) {
        if (ch >= "A" && ch <= "Z") numeric += String(ch.charCodeAt(0) - 55);
        else numeric += ch;
      }
      // MOD-97: the big number must be ≡ 1 (mod 97).
      let remainder = 0;
      for (const ch of numeric) {
        remainder = (remainder * 10 + Number(ch)) % 97;
      }
      return remainder === 1;
    } catch {
      return false;
    }
  }

  /**
   * Consulta imediata aos serviços oficiais (nif-lookup para PT ou VIES para comunitário).
   */
  private async queryOfficialData(args: {
    tenantId: string;
    countryCode: string;
    normalizedNif: string;
    normalizedVat: string;
    taxIdValid: boolean;
    iban?: string;
  }): Promise<{
    officialName?: string | null;
    address?: string | null;
    city?: string | null;
    postalCode?: string | null;
    country?: string | null;
    source: string | null;
  } | null> {
    const { tenantId, countryCode, normalizedNif, normalizedVat, taxIdValid, iban } = args;

    // Caso 1: NIF Português (mod-11 válido)
    if (countryCode === 'PT' && normalizedNif && taxIdValid) {
      let officialName: string | null = null;
      let address: string | null = null;
      let city: string | null = null;
      let postalCode: string | null = null;
      let source: string | null = null;

      if (this.nifLookup) {
        try {
          const lookup = await this.nifLookup.lookup(tenantId, 'system', normalizedNif);
          if (lookup.baseVerified || lookup.name || lookup.address) {
            officialName = lookup.name ?? null;
            if (lookup.address) {
              const parsed = parsePostalAddress(lookup.address);
              address = parsed.address ?? lookup.address;
              postalCode = parsed.postalCode ?? lookup.address.match(/\b(\d{4}-\d{3})\b/)?.[1] ?? null;
              city = parsed.city ?? this.guessCity(lookup.address);
            }
            source = 'nif-lookup';
          }
        } catch (err) {
          this.logger.warn(`[queryOfficialData] nifLookup failed for ${normalizedNif}: ${(err as Error).message}`);
        }
      }

      // Se o lookup não trouxe morada completa, tenta VIES para PT
      if ((!address || !officialName) && this.viesProvider) {
        try {
          const viesRes = await this.viesProvider.fetch({
            country: 'PT',
            nif: normalizedNif,
            iban: iban ?? null,
          });
          if (viesRes.ok) {
            const parsed = parsePostalAddress(viesRes.fields.address);
            officialName = officialName ?? viesRes.fields.name ?? null;
            address = address ?? parsed.address ?? viesRes.fields.address ?? null;
            city = city ?? parsed.city ?? viesRes.fields.city ?? null;
            postalCode = postalCode ?? parsed.postalCode ?? viesRes.fields.postalCode ?? null;
            source = source ?? 'vies';
          }
        } catch (err) {
          this.logger.warn(`[queryOfficialData] vies PT lookup failed for ${normalizedNif}: ${(err as Error).message}`);
        }
      }

      if (officialName || address) {
        return {
          officialName,
          address,
          city,
          postalCode,
          country: 'PT',
          source: source ?? 'nif-lookup',
        };
      }
    }

    // Caso 2: NIF Comunitário / Europeu (país != PT)
    if (countryCode !== 'PT' && (normalizedVat || normalizedNif) && this.viesProvider) {
      const rawVat = normalizedVat || normalizedNif;
      const cleanVat = rawVat.toUpperCase().startsWith(countryCode)
        ? rawVat.slice(countryCode.length).trim()
        : rawVat;
      try {
        const viesRes = await this.viesProvider.fetch({
          country: countryCode,
          nif: cleanVat,
          iban: iban ?? null,
        });
        if (viesRes.ok) {
          const parsed = parsePostalAddress(viesRes.fields.address);
          return {
            officialName: viesRes.fields.name ?? null,
            address: parsed.address ?? viesRes.fields.address ?? null,
            city: parsed.city ?? viesRes.fields.city ?? null,
            postalCode: parsed.postalCode ?? viesRes.fields.postalCode ?? null,
            country: countryCode,
            source: 'vies',
          };
        }
      } catch (err) {
        this.logger.warn(`[queryOfficialData] vies EU lookup failed for ${countryCode}-${cleanVat}: ${(err as Error).message}`);
      }
    }

    return null;
  }

  private async matchCategory(tenantId: string, suggested: string): Promise<string | null> {
    if (!this.prisma || !(this.prisma as any).category?.findMany) return null;
    try {
      const categories: Array<{ id: string; name: string; slug: string }> = await (this.prisma as any).category.findMany({
        where: { tenantId },
        select: { id: true, name: true, slug: true },
      });
      if (!categories || !categories.length) return null;
      const clean = suggested.toLowerCase();
      if (clean.includes('31.') || clean.includes('mercadoria')) {
        const found = categories.find((c) => c.slug === 'mercadorias-revenda' || c.name.toLowerCase().includes('revenda'));
        if (found) return found.id;
      }
      if (clean.includes('43.') || clean.includes('imobilizado') || clean.includes('equipamento')) {
        const found = categories.find((c) => c.slug === 'imobilizado' || c.name.toLowerCase().includes('imobilizado'));
        if (found) return found.id;
      }
      if (clean.includes('62.2.') || clean.includes('62.1.') || clean.includes('62.6.') || clean.includes('serviços') || clean.includes('servicos') || clean.includes('fse') || clean.includes('limpeza')) {
        const found = categories.find((c) => c.slug === 'servicos-fse' || c.name.toLowerCase().includes('serviços'));
        if (found) return found.id;
      }
      if (clean.includes('62.3.3') || clean.includes('escritório') || clean.includes('escritorio')) {
        const found = categories.find((c) => c.slug === 'material-escritorio');
        if (found) return found.id;
      }
      if (clean.includes('62.4.2') || clean.includes('combust')) {
        const found = categories.find((c) => c.slug === 'combustivel');
        if (found) return found.id;
      }
      if (clean.includes('refei') || clean.includes('restaur')) {
        const found = categories.find((c) => c.slug === 'refeicoes');
        if (found) return found.id;
      }
      const direct = categories.find((c) => clean.includes(c.name.toLowerCase()) || clean.includes(c.slug));
      return direct?.id ?? null;
    } catch {
      return null;
    }
  }

  private guessCity(address: string | null): string | null {
    if (!address) return null;
    const parts = address.split(/[,\n]/).map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) return null;
    const last = parts[parts.length - 1];
    const cityMatch = last.replace(/\b\d{4,5}-?\d{0,3}\b/g, '').trim();
    return cityMatch || null;
  }
}

/** Re-export the Prisma namespace so the extraction module can build its own types if needed. */
export { Prisma };