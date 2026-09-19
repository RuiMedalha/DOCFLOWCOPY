/**
 * DocFlow — Sidebar navigation definition.
 *
 * Single source of truth used by the sidebar nav, the topbar breadcrumb,
 * and the command palette. Keeps the icon imports here so layout files
 * stay tree-shake friendly.
 */

import {
  FileText,
  Landmark,
  GitCompare,
  Users,
  Wallet,
  Settings,
  HelpCircle,
  LayoutDashboard,
  FolderArchive,
  Trash2,
  ShieldCheck,
  ScrollText,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  Icon: LucideIcon;
  /** Sections group items in the sidebar (e.g. "Operação" vs "Suporte"). */
  section?: 'main' | 'config';
}

export const NAV_ITEMS: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', Icon: LayoutDashboard, section: 'main' },
  { href: '/documents', label: 'Documentos', Icon: FileText, section: 'main' },
  // Sprint 1.B — pending approvals. The sidebar reads the count from
  // a /approvals/pending-count endpoint so the badge stays in sync
  // without polling the full list.
  { href: '/approvals', label: 'Aprovações', Icon: ShieldCheck, section: 'main' },
  { href: '/documents/trash', label: 'Lixeira', Icon: Trash2, section: 'main' },
  { href: '/storage', label: 'Armazenamento', Icon: FolderArchive, section: 'main' },
  { href: '/banking', label: 'Banca', Icon: Landmark, section: 'main' },
  { href: '/reconciliation', label: 'Conciliação', Icon: GitCompare, section: 'main' },
  { href: '/crm', label: 'CRM', Icon: Users, section: 'main' },
  { href: '/parties', label: 'Entidades', Icon: Users, section: 'main' },
  { href: '/payments', label: 'Pagamentos', Icon: Wallet, section: 'main' },
  // Sprint 1.C — SAF-T PT exporter. Lives under Relatórios so the
  // accounting partners have a single landing page for the
  // reporting surface.
  { href: '/reports/saft', label: 'SAF-T PT', Icon: ScrollText, section: 'main' },
  { href: '/settings', label: 'Definições', Icon: Settings, section: 'config' },
  { href: '/help', label: 'Ajuda', Icon: HelpCircle, section: 'config' },
];

export const NAV_BY_HREF: Record<string, NavItem> = NAV_ITEMS.reduce(
  (acc, item) => ({ ...acc, [item.href]: item }),
  {} as Record<string, NavItem>,
);