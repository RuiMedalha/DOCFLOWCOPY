'use client';

import { useState } from 'react';
import { Mail, Pencil, Phone, Plus, Trash2, User as UserIcon } from 'lucide-react';
import type { PartyContact } from '../../_lib/types';
import {
  useCreateContact,
  useDeleteContact,
  usePartyContacts,
  useUpdateContact,
} from '../../_components/use-parties';

interface ContactsTabProps {
  partyId: string;
  isAdmin: boolean;
}

/**
 * ContactsTab — list of named contacts for a party with add/edit/delete
 * dialogs. Avatar is rendered as initials on a coloured circle (no
 * network round-trip needed). The unique-email constraint is enforced
 * server-side via the @@@unique([tenantId, partyId, email]) index —
 * the dialog shows the 409 message verbatim from the API.
 */
export function ContactsTab({ partyId, isAdmin }: ContactsTabProps) {
  const { data, isLoading } = usePartyContacts(partyId);
  const create = useCreateContact();
  const update = useUpdateContact();
  const remove = useDeleteContact();

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<PartyContact | null>(null);

  const items = data?.items ?? [];

  if (isLoading) {
    return <div className="card p-6 text-sm text-muted">A carregar…</div>;
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Contactos</h2>
          <p className="text-xs text-muted">
            Pessoas que podem ser contactadas para esta entidade (CFO, contabilista, comercial, …).
          </p>
        </div>
        {isAdmin && (
          <button
            type="button"
            className="btn-primary btn-sm"
            onClick={() => setAdding(true)}
          >
            <Plus size={14} aria-hidden /> Adicionar contacto
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <div className="card p-6 text-sm text-muted">
          Sem contactos — adicione o primeiro quando precisar de chegar a alguém
          desta entidade.
        </div>
      ) : (
        <ul className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {items.map((c) => (
            <li key={c.id} className="card p-4 flex gap-3 items-start">
              <ContactAvatar name={c.name} />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{c.name}</div>
                {c.role && (
                  <div className="text-xs text-muted truncate">{c.role}</div>
                )}
                <div className="mt-1 flex flex-col gap-0.5 text-xs text-muted">
                  {c.email && (
                    <a
                      href={`mailto:${c.email}`}
                      className="inline-flex items-center gap-1 hover:text-default"
                    >
                      <Mail size={11} aria-hidden /> {c.email}
                    </a>
                  )}
                  {c.phone && (
                    <a
                      href={`tel:${c.phone}`}
                      className="inline-flex items-center gap-1 hover:text-default"
                    >
                      <Phone size={11} aria-hidden /> {c.phone}
                    </a>
                  )}
                  {!c.email && !c.phone && (
                    <span className="text-[10px] italic text-muted/70">
                      Sem email nem telefone
                    </span>
                  )}
                </div>
              </div>
              {isAdmin && (
                <div className="flex flex-col gap-1">
                  <button
                    type="button"
                    aria-label={`Editar ${c.name}`}
                    onClick={() => setEditing(c)}
                    className="btn-ghost btn-icon"
                  >
                    <Pencil size={13} aria-hidden />
                  </button>
                  <button
                    type="button"
                    aria-label={`Eliminar ${c.name}`}
                    onClick={() => {
                      if (confirm(`Eliminar o contacto ${c.name}?`)) {
                        remove.mutate({ partyId, id: c.id });
                      }
                    }}
                    className="btn-ghost btn-icon"
                  >
                    <Trash2 size={13} aria-hidden />
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <ContactDialog
          title="Novo contacto"
          onClose={() => setAdding(false)}
          onSubmit={(input) => {
            create.mutate(
              { partyId, ...input },
              {
                onSuccess: () => setAdding(false),
                onError: (err) =>
                  alert(
                    err instanceof Error
                      ? err.message
                      : 'Erro a criar contacto',
                  ),
              },
            );
          }}
        />
      )}

      {editing && (
        <ContactDialog
          title={`Editar ${editing.name}`}
          initial={{
            name: editing.name,
            role: editing.role ?? '',
            email: editing.email ?? '',
            phone: editing.phone ?? '',
            notes: editing.notes ?? '',
          }}
          onClose={() => setEditing(null)}
          onSubmit={(input) => {
            update.mutate(
              { partyId, id: editing.id, ...input },
              {
                onSuccess: () => setEditing(null),
                onError: (err) =>
                  alert(
                    err instanceof Error
                      ? err.message
                      : 'Erro a atualizar contacto',
                  ),
              },
            );
          }}
        />
      )}
    </section>
  );
}

/** Render 2-letter initials on a coloured circle. Deterministic palette. */
function ContactAvatar({ name }: { name: string }) {
  const initials = name
    .trim()
    .split(/\s+/)
    .map((p) => p[0] ?? '')
    .slice(0, 2)
    .join('')
    .toUpperCase();
  // Hash name → one of 6 swatches so the same person always sees the
  // same color across page loads. No network call, no flicker.
  const swatches = [
    'bg-sky-100 text-sky-700',
    'bg-emerald-100 text-emerald-700',
    'bg-amber-100 text-amber-700',
    'bg-rose-100 text-rose-700',
    'bg-violet-100 text-violet-700',
    'bg-slate-100 text-slate-700',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  const swatch = swatches[hash % swatches.length];
  return (
    <div
      aria-hidden
      className={`w-10 h-10 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 ${swatch}`}
    >
      {initials || <UserIcon size={14} aria-hidden />}
    </div>
  );
}

interface ContactDialogProps {
  title: string;
  initial?: {
    name?: string;
    role?: string;
    email?: string;
    phone?: string;
    notes?: string;
  };
  onClose: () => void;
  onSubmit: (input: {
    name: string;
    role?: string;
    email?: string;
    phone?: string;
    notes?: string;
  }) => void;
}

function ContactDialog({ title, initial = {}, onClose, onSubmit }: ContactDialogProps) {
  const [name, setName] = useState(initial.name ?? '');
  const [role, setRole] = useState(initial.role ?? '');
  const [email, setEmail] = useState(initial.email ?? '');
  const [phone, setPhone] = useState(initial.phone ?? '');
  const [notes, setNotes] = useState(initial.notes ?? '');

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="card p-6 w-full max-w-md space-y-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        <div>
          <label className="text-xs block mb-1" htmlFor="contact-name">Nome *</label>
          <input
            id="contact-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="input w-full"
            maxLength={255}
            required
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs block mb-1">Cargo</label>
            <input
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="input w-full"
              maxLength={100}
            />
          </div>
          <div>
            <label className="text-xs block mb-1">Telefone</label>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="input w-full"
              maxLength={30}
            />
          </div>
        </div>
        <div>
          <label className="text-xs block mb-1">Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="input w-full"
            maxLength={255}
          />
        </div>
        <div>
          <label className="text-xs block mb-1">Notas</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="input w-full"
            rows={3}
            maxLength={2000}
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-secondary btn-sm" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            className="btn-primary btn-sm"
            disabled={!name.trim()}
            onClick={() =>
              onSubmit({
                name: name.trim(),
                role: role.trim() || undefined,
                email: email.trim() || undefined,
                phone: phone.trim() || undefined,
                notes: notes.trim() || undefined,
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
