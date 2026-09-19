'use client';

import { useState } from 'react';
import { Pencil, Plus, Star, Trash2 } from 'lucide-react';
import type { PartyAddress, PartyAddressType } from '../../_lib/types';
import {
  useCreateAddress,
  useDeleteAddress,
  usePartyAddresses,
  useUpdateAddress,
} from '../../_components/use-parties';

interface AddressesTabProps {
  partyId: string;
  isAdmin: boolean;
}

const TYPE_LABELS: Record<PartyAddressType, string> = {
  BILLING: 'Faturação',
  CORRESPONDENCE: 'Correspondência',
  OPERATIONAL: 'Operacional (sede/armazém)',
  OTHER: 'Outra',
};

const TYPE_ORDER: PartyAddressType[] = [
  'BILLING',
  'CORRESPONDENCE',
  'OPERATIONAL',
  'OTHER',
];

/**
 * AddressesTab — addresses grouped by `type`, each group sorted by
 * `isPrimary DESC` so the primary of each type floats to the top.
 * Country shown as ISO code in upper case (PT, ES, …). The "Editar"
 * action toggles `isPrimary` in addition to the field-level edits.
 */
export function AddressesTab({ partyId, isAdmin }: AddressesTabProps) {
  const { data, isLoading } = usePartyAddresses(partyId);
  const create = useCreateAddress();
  const update = useUpdateAddress();
  const remove = useDeleteAddress();

  const [adding, setAdding] = useState<PartyAddressType | null>(null);
  const [editing, setEditing] = useState<PartyAddress | null>(null);

  const items = data?.items ?? [];

  const grouped: Record<PartyAddressType, PartyAddress[]> = {
    BILLING: [],
    CORRESPONDENCE: [],
    OPERATIONAL: [],
    OTHER: [],
  };
  for (const a of items) grouped[a.type].push(a);

  // The service returns sorted by isPrimary DESC then type ASC; we still
  // group locally so empty groups can render a placeholder row.

  if (isLoading) {
    return <div className="card p-6 text-sm text-muted">A carregar…</div>;
  }

  return (
    <section className="space-y-5">
      <div>
        <h2 className="text-sm font-semibold">Moradas</h2>
        <p className="text-xs text-muted">
          Moradas agrupadas por tipo. A primeira de cada grupo é a morada
          primária (mais usada para faturação, envios, etc.).
        </p>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        {TYPE_ORDER.map((type) => {
          const group = grouped[type];
          return (
            <div key={type} className="card p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wide">
                  {TYPE_LABELS[type]}
                </h3>
                {isAdmin && (
                  <button
                    type="button"
                    aria-label={`Adicionar morada de ${TYPE_LABELS[type]}`}
                    className="btn-ghost btn-icon"
                    onClick={() => setAdding(type)}
                  >
                    <Plus size={13} aria-hidden />
                  </button>
                )}
              </div>
              {group.length === 0 ? (
                <div className="text-xs italic text-muted py-2">
                  Sem morada registada para este tipo.
                </div>
              ) : (
                <ul className="space-y-2">
                  {group.map((a) => (
                    <li
                      key={a.id}
                      className={
                        'rounded-md border p-3 text-xs ' +
                        (a.isPrimary
                          ? 'border-emerald-300 bg-emerald-50/50'
                          : 'border-border bg-white')
                      }
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-default truncate">
                            {a.line1}
                            {a.line2 && <span>, {a.line2}</span>}
                          </div>
                          <div className="text-muted">
                            {a.postalCode && `${a.postalCode} `}
                            {a.city && `${a.city} · `}
                            <span className="font-mono text-[10px] uppercase tracking-wider">
                              {a.country}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {a.isPrimary && (
                            <span
                              className="inline-flex items-center gap-0.5 text-[10px] text-emerald-700 font-medium"
                              title="Morada primária deste tipo"
                            >
                              <Star size={10} aria-hidden /> Primária
                            </span>
                          )}
                          {isAdmin && (
                            <>
                              <button
                                type="button"
                                aria-label={`Editar ${a.line1}`}
                                className="btn-ghost btn-icon"
                                onClick={() => setEditing(a)}
                              >
                                <Pencil size={12} aria-hidden />
                              </button>
                              <button
                                type="button"
                                aria-label={`Apagar ${a.line1}`}
                                className="btn-ghost btn-icon"
                                onClick={() => {
                                  if (confirm(`Apagar a morada "${a.line1}"?`)) {
                                    remove.mutate({ partyId, id: a.id });
                                  }
                                }}
                              >
                                <Trash2 size={12} aria-hidden />
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {(adding || editing) && (
        <AddressDialog
          title={
            editing
              ? `Editar morada`
              : `Nova morada — ${adding ? TYPE_LABELS[adding] : ''}`
          }
          initial={
            editing ?? {
              id: '',
              partyId,
              type: (adding ?? 'OTHER') as PartyAddressType,
              line1: '',
              country: 'PT',
              isPrimary: false,
              createdAt: '',
              updatedAt: '',
            }
          }
          onClose={() => {
            setAdding(null);
            setEditing(null);
          }}
          onSubmit={(input) => {
            const submit = (data: typeof input) => {
              if (editing) {
                update.mutate(
                  { partyId, id: editing.id, ...data },
                  {
                    onSuccess: () => {
                      setEditing(null);
                    },
                    onError: (err) =>
                      alert(err instanceof Error ? err.message : 'Erro a atualizar morada'),
                  },
                );
              } else {
                create.mutate(
                  { partyId, ...data },
                  {
                    onSuccess: () => {
                      setAdding(null);
                    },
                    onError: (err) =>
                      alert(err instanceof Error ? err.message : 'Erro a criar morada'),
                  },
                );
              }
            };
            submit(input);
          }}
        />
      )}
    </section>
  );
}

interface AddressDialogProps {
  title: string;
  initial: Partial<PartyAddress>;
  onClose: () => void;
  onSubmit: (input: {
    type: PartyAddressType;
    line1: string;
    line2?: string;
    postalCode?: string;
    city?: string;
    country?: string;
    isPrimary?: boolean;
  }) => void;
}

function AddressDialog({ title, initial, onClose, onSubmit }: AddressDialogProps) {
  const [type, setType] = useState<PartyAddressType>(
    (initial.type as PartyAddressType) ?? 'BILLING',
  );
  const [line1, setLine1] = useState(initial.line1 ?? '');
  const [line2, setLine2] = useState(initial.line2 ?? '');
  const [postalCode, setPostalCode] = useState(initial.postalCode ?? '');
  const [city, setCity] = useState(initial.city ?? '');
  const [country, setCountry] = useState(initial.country ?? 'PT');
  const [isPrimary, setIsPrimary] = useState(Boolean(initial.isPrimary));

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="card p-6 w-full max-w-md space-y-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        <div>
          <label className="text-xs block mb-1">Tipo</label>
          <select
            className="input w-full"
            value={type}
            onChange={(e) => setType(e.target.value as PartyAddressType)}
          >
            {TYPE_ORDER.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs block mb-1">Linha 1 *</label>
          <input
            value={line1}
            onChange={(e) => setLine1(e.target.value)}
            className="input w-full"
            maxLength={255}
            required
          />
        </div>
        <div>
          <label className="text-xs block mb-1">Linha 2</label>
          <input
            value={line2}
            onChange={(e) => setLine2(e.target.value)}
            className="input w-full"
            maxLength={255}
          />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-1">
            <label className="text-xs block mb-1">Cód. postal</label>
            <input
              value={postalCode}
              onChange={(e) => setPostalCode(e.target.value)}
              className="input w-full"
              maxLength={20}
            />
          </div>
          <div className="col-span-2">
            <label className="text-xs block mb-1">Cidade</label>
            <input
              value={city}
              onChange={(e) => setCity(e.target.value)}
              className="input w-full"
              maxLength={100}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 items-end">
          <div>
            <label className="text-xs block mb-1">País (ISO-2)</label>
            <input
              value={country}
              onChange={(e) => setCountry(e.target.value.toUpperCase())}
              className="input w-full uppercase"
              maxLength={2}
            />
          </div>
          <label className="text-xs inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={isPrimary}
              onChange={(e) => setIsPrimary(e.target.checked)}
            />
            <Star size={11} aria-hidden /> Marcar como primária
          </label>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-secondary btn-sm" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            className="btn-primary btn-sm"
            disabled={!line1.trim()}
            onClick={() =>
              onSubmit({
                type,
                line1: line1.trim(),
                line2: line2.trim() || undefined,
                postalCode: postalCode.trim() || undefined,
                city: city.trim() || undefined,
                country: country.trim() || 'PT',
                isPrimary,
              })
            }
          >
            Guardar
          </button>
        </div>
      </div>
    </div>
  );
}
