# Design System — DocFlow `/documents/[id]` Redesign

> Mission: **Editorial / Contábil · Blueprint Edition**
> Author: designer-ui pane (Opus 5). Skill: `frontend-design`.
> Skill that came back Unknown: `oc-api-audit`, `oc-billing-webhooks` — declared in SKILL LOAD CONTRACT but not present in this environment, so no skill-instructed audit could be loaded. Proceeding with the locked mission brief as-is; orchestrator owns the audit/sku side independently.
> Status: READ-ONLY design spec. Implementation phase follows after orchestrator approval.

---

## 1. Design direction summary

**Aesthetic name:** **Editorial / Contábil · Blueprint Edition**

A página de detalhe de documento é uma **mesa de revisão de auditor fiscal**, não um dashboard genérico. Tratamos o documento (PDF/imagem) como o original em papel; o painel de campos como a ficha de auditoria que o contador preenche à mão; os totais como uma equação tipográfica que cabe numa única linha de jornal.

- **Audience emocional:** Contabilista / operador fiscal português que precisa **confiança técnica acima de tudo**. Não quer brincadeira, quer decência e precisão.
- **First 3 seconds deve transmitir:** "Isto é sério, eu sei o que estou a fazer, isto cabe no meu fluxo."
- **Tone:** Editorial / Magazine / Refined. **Decisão: não misturar com mais nenhum outro tom.**
- **Memory anchor:** nº de documento oversized mono (`FT 2026/1234` em ~56px JetBrains Mono, navy + accent-gold gradient nos 2 primeiros chars). Posicionado no topo do header, acima de qualquer outro elemento. É o "logo sem logo" — se remover a wordmark da DocFlow, ainda se reconhece esta página pelo número.

### Key inspiration (conceptual, NOT visual plagiarism)

- **Bloomberg Terminal** → oversized mono identifiers + tabular num discipline. Não copiamos o visual laranja/preto, mas copiamos a regra: *números que importam vão em mono gigante*.
- **The Economist** → serif editorial com peso forte em headlines + hairline rules entre seções + sidenotes. Não copiamos a marca; copiamos a estrutura de "artigo de jornal".
- **Stripe Invoice editor** → mono para IDs, accent discreto, equação de totais como arte-final. Não copiamos o layout; copiamos o princípio de "fatura é objeto, não dado".

---

## 2. DFII score

| Dimension | Score | Justification |
|---|---|---|
| **Aesthetic Impact** | 5/5 | Editorial New 56px como display + JetBrains Mono 48px+ nº doc como anchor + cream dominante é uma combinação única em SaaS PT. Nenhuma outra página de auditoria fiscal usa isso. |
| **Context Fit** | 5/5 | Auditoria fiscal PT é literalmente o domínio onde cream + navy serif + mono é semanticamente fiel (papel de escritório / tinta de carimbo / selo oficial). Não é aesthetic imposition, é fidelity. |
| **Implementation Feasibility** | 3/5 | `next/font/google` aceita múltiplas famílias; Tailwind theme extend aditivo; CSS variables adicionadas sem remover existentes. Único custo: ~50-80kb de payload de font (woff2 latin). Risco de regressão zero na base porque tudo é additive. |
| **Performance Safety** | 4/5 | Duas webfonts extra com `display: swap` (default). Sem JS novo, sem motion pesado. Único risco: FOUT em 3G com cache vazio — aceitável (suportado por fallback chain robusto). |
| **Consistency Risk** | **2 (subtract)** | Risco real: a página redesignada cria um sistema paralelo (Editorial tokens) que pode divergir do resto do app (que segue Inter + sky/indigo/violet). Mitigação: bloco de variáveis ativado por classe `.editorial-skin` no `<body>` apenas em `/documents/[id]`. Outras páginas permanecem intocadas. |

```
DFII = (5 + 5 + 3 + 4) − 2 = 15
```

Excelente — range 12-15, **executar com disciplina**.

---

## 3. Design system snapshot

### 3.1 Fonts (com rationale)

| Role | Font | Weights | Porquê |
|---|---|---|---|
| **Display** | **Editorial New** (Google Fonts via `next/font/google`) | 300 / 500 / 700 | Serif moderna editorial — anchors da hierarquia. 700 nos títulos de seção, 500 nos subtítulos, 300 em blocks opcionais (e.g. hero subtitle). Footer line: "FT 2026/1234 · revisão fiscal". |
| **Body** | **Inter Tight** (Google Fonts via `next/font/google`) | 400 / 500 / 600 | Geometric humanist sans apertado. Mais jornalístico que Inter regular; casa com editorial sem ficar literário. Usado em labels, meta, descrições, button text, table cells. |
| **Mono / Data** | **JetBrains Mono** (já existe no projeto) | 400 / 500 / 700 | Para NIF, IBAN, ATCUD, nº doc, totais, código de linha. Tabular-nums sempre. |
| **Fallback chain** | system-ui, ui-serif, ui-sans-serif | — | Robusto se webfont falhar. |

> **Anti-pattern evitado:** Nenhum Inter puro (skill flag explícito). Inter **Tight** só, com partner serif. Mesmo Inter Tight pesa bem menos que Inter regular no carácter.

### 3.2 Color variables (CSS vars — adicionar bloco, NÃO remover nada)

Bloco adicionado em `:root`, com override em `[data-skin='editorial']` para ativação segmentada:

```css
:root,
[data-skin='editorial'] {
  /* Canvas — dominante cream (papel de escritório) */
  --ed-canvas:    #fbf9f4;       /* bg principal */
  --ed-canvas-2:  #f6f2e8;       /* hover de linha / table zebra sutil */
  --ed-panel:    #ffffff;       /* card surface white, contraste com cream */

  /* Ink — navy (tinta de carimbo) */
  --ed-ink:        #14213d;      /* headings, body emphasis */
  --ed-ink-soft:   #5c6478;      /* body normal */
  --ed-ink-faint:  #8a93a6;      /* labels, captions */
  --ed-rule:       rgba(20, 33, 61, 0.12);  /* hairline padrão */
  --ed-rule-strong: rgba(20, 33, 61, 0.28); /* divisor de seção mais pesado */

  /* Accent — dourado (selo/selo de cartório) */
  --ed-accent-gold:     #cba65a;             /* primary accent */
  --ed-accent-gold-dim: rgba(203, 166, 90, 0.16);
  --ed-accent-gold-strong: #a8893f;

  /* Accent secondaires — numerais / navy gradient pair */
  --ed-ink-num:         #14213d;             /* mono nº doc base */
  --ed-accent-gold-num: linear-gradient(180deg, #cba65a 0%, #a8893f 100%);

  /* Status — 4 tons distintos, todos AA no cream */
  --ed-status-ok:        #4f7942;            /* forest green */
  --ed-status-ok-dim:    rgba(79, 121, 66, 0.14);
  --ed-status-warn:      #b8860b;            /* mustard (≠ accent gold) */
  --ed-status-warn-dim:  rgba(184, 134, 11, 0.14);
  --ed-status-alert:     #8b2e2a;            /* wine (≠ rose/IBAN mismatch original) */
  --ed-status-alert-dim: rgba(139, 46, 42, 0.12);
  --ed-status-neutral:   #5c6478;
  --ed-status-neutral-dim: rgba(92, 100, 120, 0.10);

  /* Geometry — editorial committee */
  --ed-radius-hairline: 0;       /* hairlines */
  --ed-radius-chip:     4px;     /* data chips (small badges) */
  --ed-radius-card:     12px;    /* cards maiores */
  --ed-radius-pill:     999px;   /* status pills */

  /* Shadows — NENHUMA drop-shadow pesada. Só flutuantes */
  --ed-shadow-popover:   0 1px 0 var(--ed-rule), 0 8px 24px -8px rgba(20, 33, 61, 0.10);
  --ed-shadow-hover:    0 1px 0 var(--ed-rule), 0 12px 28px -10px rgba(20, 33, 61, 0.18);

  /* Motion — 2 timings apenas */
  --ed-ease:           cubic-bezier(0.2, 0.8, 0.2, 1);
  --ed-motion:         240ms;
  --ed-motion-slow:    380ms;
}
```

### 3.3 Spacing rhythm

4 / 8 / 12 / 16 / 24 / 40 / 64 (commit):
- **4** — entre label e input
- **8** — entre fields do mesmo group
- **12** — padding interno de chips
- **16** — padding de card sub-section
- **24** — padding de card section + gap entre groups
- **40** — gutter entre colunas + padding de seção principal
- **64** — distância entre seções "macro" (hero status → fields → reconciliation)

Max-width da área: **1280px**, gutter lateral **40px** desktop / **16px** mobile.

### 3.4 Border radii — 4 valores fixos

| Raio | Uso |
|---|---|
| `0` | Hairlines entre seções, table borders |
| `4px` | Data chips (ATCUD, NIF pills) |
| `12px` | Cards principais (FieldPanel section) |
| `999px` | Status pills (EM REVISÃO / APROVADO) |

**Commit:** SEM cantos arredondados "decorativos" semânticos. Cada raio tem um papel.

### 3.5 Shadow strategy

**SEM drop-shadows pesadas.** Princípio:
- 99% da página não tem shadow — só hairline 1px navy @ 0.12.
- 1% (popovers, dropdowns) usa `--ed-shadow-popover` (hairline + 8px blur leve).
- Status pulse (badge EM REVISÃO) usa shadow inline apenas no pulse keyframe.

### 3.6 Motion philosophy

**2 keyframes no total, mais nada.**

```css
@keyframes edFadeIn {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}

@keyframes edPulseGold {
  0%, 100% { box-shadow: 0 0 0 0 rgba(203, 166, 90, 0.35); }
  50%      { box-shadow: 0 0 0 8px rgba(203, 166, 90, 0); }
}
```

- **edFadeIn** → aplica-se ao grid root em mount (substitui o `.animate-in`).
- **edPulseGold** → aplica-se SOMENTE ao hero status badge quando documento está EM_REVISAO (não CONCILIADO, não PAGO).

Tudo o resto: hover state com 240ms `--ed-ease`. Sem `transition: all`. Sem shimmer. Sem orb-drift.

---

## 4. Layout restructure proposta

### 4.1 Header — 3 camadas verticais

```
┌──────────────────────────────────────────────────────────────────┐
│  ← Voltar · Documentos                          ⌘S Salvar  ⌘↵ Aprovar │
│  ─────────────────────────────────────────────────────────────── │
│                                                                    │
│   FT 2026/1234              ← JetBrains Mono 56px, navy +        │
│                              accent gold gradient nos chars 0-1   │
│                                                                    │
│   EDP Comercial — Comercialização de Energia, S.A.                │
│   NIF 500000001  ·  Emissão 2026-08-15  ·  Vencimento 2026-09-14 │
│                                                                    │
└──────────────────────────────────────────────────────────────────┘
```

**Camada 1 (top):** breadcrumb fino (`← Voltar · Documentos`) à esquerda, keyboard hints à direita.

**Camada 2 (center-stage):** o nº doc oversized mono. **Eis o anchor memorável.** É a primeira coisa que o olho vê.

**Camada 3 (meta):** fornecedor + NIF + datas em Inter Tight 14px navy-soft. Hairline navy 0.12 separando camada 2 de 3.

### 4.2 Hero status — não badge, banner

```
┌──────────────────────────────────────────────────────────────────┐
│  ●  PRONTO PARA REVISAR                       [Re-extrair]        │
│     2 alterações desde a extração. Ultima há 12 min.  [Histórico] │
└──────────────────────────────────────────────────────────────────┘
```

**Banner de ~80px height** (não 56px — generoso, respira). Borda esquerda 4px solid `--ed-accent-gold` se EM_REVISAO, `--ed-status-ok` se APROVADO, `--ed-status-alert` se REJEITADO.

- **EM REVISÃO:** dot gold pulsing, texto serif 20px "PRONTO PARA REVISAR", sub-texto Inter Tight 13px.
- **APROVADO:** dot green, "APROVADO POR RUI · 14:32", sub-texto com data.
- **REJEITADO:** dot wine, "REJEITADO POR MARTA · 10:08 — IBAN não confere".

Botão "Re-extrair" discreto à direita (ghost, navy-soft). Banner é o segundo nível de hierarquia — vem depois do nº doc mas acima de qualquer fieldset.

### 4.3 Body — divisão editorial por HAIRLINES, não cards

Em vez de 8 cards empilhados com mesmo bg/sombra, o body divide-se em **5 zonas editoriais** separadas por hairline navy 0.12 inline:

```
┌──────────────────────────────────────────────────────────────────┐
│   IDENTIDADE   ·   CALENDÁRIO   ·   VALIDAÇÃO                    │
│   ─────────────────────────────────────────────────────────────── │
│   Fornecedor / NIF / Nº doc / ATCUD        │  Data doc / Venc /  │
│                                            │  IBAN              │
│                                                                    │
│   ─────────────────────────────────────────────────────────────── │
│   LINHAS DA FATURA (4)                                             │
│                                                                    │
│   [tabela editorial — header small caps, mono tabular, right-      │
│    rule + gold underline no tfoot]                                  │
│                                                                    │
│   ─────────────────────────────────────────────────────────────── │
│   RECONCILIAÇÃO                                                    │
│                                                                    │
│   [Base 128,06] + [IVA 23,39]  ───────────────►  [Total 151,45]    │
│       ●          ●                                 ●              │
│   [Soma linhas 128,06]                          [Δ −23,39 ⚠]      │
│                                                                    │
│   ─────────────────────────────────────────────────────────────── │
│   CONTABILIZAÇÃO · TOConline                                       │
└──────────────────────────────────────────────────────────────────┘
```

**FieldPanel regrouped em 3 grupos horizontais** (não 8 cards):
- **IDENTIDADE** (Fornecedor, NIF, Nº doc, ATCUD)
- **CALENDÁRIO** (Data doc, Vencimento, IBAN)
- **VALIDAÇÃO** (categoria, status IBAN, QR-AT inline)

Cada grupo: header serif editorial 18px + hairline 2px navy 0.28 + fields em grid 2-col.

### 4.4 Tabela editorial — header small caps, mono tabular

- **Header:** Inter Tight 11px, uppercase, letter-spacing 0.12em, cor `--ed-ink-faint`. Background transparent.
- **Rows:** JetBrains Mono 14px para valores numéricos; Inter Tight 14px para descrição. Padding 14px vertical.
- **Hover:** bg `--ed-canvas-2` (cream ligeiramente mais saturado), sem border mudança.
- **Totais (`<tfoot>`):** JetBrains Mono 16px weight 500, com right-rule gold 2px na última coluna de total. Sublinha auditivamente: "isto é o número que se leva".

### 4.5 Reconciliation footer — equação tipográfica

Em vez de 3 colunas sem hierarquia:

```
   BASE                IVA                   TOTAL
   128,06 EUR          +   23,39 EUR     ─→  151,45 EUR
                                          ─────────────
   Soma linhas                                128,06 EUR
                                          ─────────────
   Diferença                                    0,00 EUR ✓
```

- **Linha 1 (operação):** mono 16px navy + accent gold em `+` e `─→`
- **Linhas 2-3 (verificações):** navy-soft 14px, delta com check verde ou warning mostarda
- **Hairline 1px gold** abaixo de cada número final — sublinha auditivamente

Visualmente parece uma equação de jornal, não uma tabela.

### 4.6 DocumentViewer — frame navy + gold inset

**SEM redimensionar o PDF** (decisão do scout: `min-h-[420px]` está OK).

- **Frame:** border 1px navy 0.12, 1px gold inset TOP border (`box-shadow: inset 0 1px 0 var(--ed-accent-gold)`).
- **Resultado:** o documento fica "dentro de uma capa editorial". Gold sutil mas reconhecível.
- **Toolbar:** filename em Inter Tight 13px navy + 2 botões ghost à direita.
- **Sem redimensionamento:** mantém-se como está.

---

## 5. Diferenciação — o que esta página evita

| ❌ Anti-pattern | ✅ Esta página |
|---|---|
| Inter única | Editorial New (display) + Inter Tight (body) + JetBrains Mono (data). 3 famílias com papéis distintos. |
| Paleta evenly-balanced (sky/indigo/violet na mesma proporção) | Cream dominante (80%), navy como tinta (15%), gold como selo (5%). Status em 4 tons distintos do accent. |
| Layout SaaS genérico (card grid + sidebar) | 5 zonas editoriais separadas por hairlines, header em 3 camadas verticais, hero status como banner com dot pulsing. |
| Status badge competindo com danger color (rose para REJEITADO + IBAN mismatch + delete) | 4 tons distintos: gold (accent), forest green (OK), mustard (warn ≠ gold), wine (alert ≠ rose). Cada um com cor e papel. |
| `:hover` opacity com transition-all | 240ms cubic-bezier em propriedades específicas, sem transition-all. |
| Drop-shadow pesadas | Hairlines + 1 sombra fina só em popovers. Página parece gravada, não flutuante. |

---

## 6. Implementation specs (para a fase 2 — após aprovação do orchestrator)

### 6.1 CSS variables a adicionar
Lista completa no §3.2. Resumo: `--ed-*` (28 vars), todas dentro de `:root, [data-skin='editorial']`. Nenhuma variável existente é removida.

### 6.2 Fontes via `next/font/google`
- `Editorial_New` (peso 300/500/700, latin subset, variável `--font-editorial`)
- `Inter_Tight` (peso 400/500/600, latin subset, variável `--font-inter-tight`)

> `Inter` já está carregada em `--font-inter` — **manter** porque o resto da app usa. `Inter_Tight` é família separada, vai coexistir.

### 6.3 Tailwind theme extend
Adicionar (não substituir):
```ts
extend: {
  colors: {
    'ed-canvas':       'var(--ed-canvas)',
    'ed-canvas-2':     'var(--ed-canvas-2)',
    'ed-panel':        'var(--ed-panel)',
    'ed-ink':          'var(--ed-ink)',
    'ed-ink-soft':     'var(--ed-ink-soft)',
    'ed-ink-faint':    'var(--ed-ink-faint)',
    'ed-rule':         'var(--ed-rule)',
    'ed-accent-gold':  'var(--ed-accent-gold)',
    'ed-accent-gold-dim': 'var(--ed-accent-gold-dim)',
    'ed-status-ok':    'var(--ed-status-ok)',
    'ed-status-warn':  'var(--ed-status-warn)',
    'ed-status-alert': 'var(--ed-status-alert)',
    'ed-status-neutral': 'var(--ed-status-neutral)',
  },
  fontFamily: {
    editorial: ['var(--font-editorial)', 'ui-serif', 'Georgia', 'serif'],
    'inter-tight': ['var(--font-inter-tight)', 'system-ui', 'sans-serif'],
    mono: ['"JetBrains Mono"', 'ui-monospace', 'SF Mono', 'monospace'], // already
  },
  animation: {
    'ed-fade': 'edFadeIn 280ms cubic-bezier(0.2, 0.8, 0.2, 1) both',
    'ed-pulse-gold': 'edPulseGold 2.4s cubic-bezier(0.2, 0.8, 0.2, 1) infinite',
  },
}
```

### 6.4 Ordem de implementação (5 fases)

1. **Fase 1 — Design System base** (este commit): adicionar vars `ed-*` no `globals.css`, carregar `Editorial_New` e `Inter_Tight` no `layout.tsx`, estender Tailwind. **Zero alterações em componentes.**
2. **Fase 2 — Skeleton editorial** (próxima missão, após orchestrator aprovar): wrapper component `<EditorialSkin>` que aplica `data-skin='editorial'` + classes base. Aplicar só em `/documents/[id]/page.tsx`.
3. **Fase 3 — Header 3 camadas** + nº doc oversized mono.
4. **Fase 4 — Hero status banner** (substitui `statusTone` badge atual).
5. **Fase 5 — Body restructure** (5 zonas editoriais, reconciliation como equação).
6. **Fase 6 — DocumentViewer frame** + ajustes finais + Playwright proof.

---

## 7. Anti-patterns evitados ativamente

Marcados pelo skill como **Immediate Failure** se detectados:

- ❌ **Inter/Roboto/system fonts:** Evitado — display = Editorial New, body = Inter Tight (≠ Inter), data = JetBrains Mono.
- ❌ **Purple-on-white SaaS gradients:** Evitado — paleta cream/navy/gold sem purple. Nenhum gradient decorativo.
- ❌ **Default Tailwind/ShadCN layouts:** Evitado — 5 zonas editoriais com hairlines ≠ grid de cards.
- ❌ **Symmetrical, predictable sections:** Evitado — hero status é assimétrico (dot à esquerda, ações à direita), reconciliation é uma equação não linear.
- ❌ **Overused AI design tropes:** Evitado — sem glassmorphism exagerado, sem gradient mesh bg, sem "aurora bg", sem blob shapes.
- ❌ **Decoration without intent:** Cada flourish serve a tese editorial: hairlines = jornal; gold = selo; mono oversized = auditabilidade.

---

## 8. Operador checklist (auto-avaliação pré-submit)

- [x] Clear aesthetic direction stated ("Editorial / Contábil · Blueprint Edition")
- [x] DFII = 15 (≥ 8)
- [x] One memorable design anchor (nº doc 56px JetBrains Mono + gold gradient nos 2 primeiros chars)
- [x] No generic fonts (Editorial New + Inter Tight + JetBrains Mono)
- [x] No generic palette (cream dominante + navy + gold accent)
- [x] No generic layout (5 zonas editoriais, header 3 camadas, hero banner)
- [x] Code ambition matches design (font load + vars extend + Tailwind additive — all clean)
- [x] Accessible & performant (display swap + additivo sem remover nada)

---

## 9. Ficheiros que serão alterados na fase de implementação

**Confirmado fora-de-escopo desta fase:**
- `apps/web/app/(dashboard)/documents/[id]/page.tsx`
- `apps/web/app/(dashboard)/documents/[id]/_components/field-panel.tsx`
- `apps/web/app/(dashboard)/documents/[id]/_components/document-viewer.tsx`
- `apps/web/app/(dashboard)/documents/[id]/_components/qr-badge.tsx`
- `apps/web/app/(dashboard)/documents/[id]/_components/fraud-warning.tsx`

**Alterados nesta fase (3):**
- `apps/web/app/globals.css` ← adicionar bloco `:root, [data-skin='editorial']` com vars `--ed-*` e 2 keyframes (`edFadeIn`, `edPulseGold`)
- `apps/web/app/layout.tsx` ← adicionar imports `Editorial_New` e `Inter_Tight` de `next/font/google`, com `variable` em seus respectivos `--font-*`
- `apps/web/tailwind.config.ts` ← adicionar `colors.ed-*`, `fontFamily.editorial` + `inter-tight`, `animation.ed-*`

---

**End of design system doc. Aguardando aprovação do orchestrator para iniciar Fase 2 (skeleton editorial + componentes).**
