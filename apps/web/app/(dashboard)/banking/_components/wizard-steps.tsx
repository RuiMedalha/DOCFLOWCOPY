'use client';

import { Check } from 'lucide-react';
import { WIZARD_STEPS, type WizardStep } from '../_lib/types';

export function WizardSteps({ current }: { current: WizardStep }) {
  const currentIndex = WIZARD_STEPS.findIndex((s) => s.id === current);

  return (
    <nav aria-label="Passos do assistente" className="mb-6">
      <ol className="flex items-center justify-between w-full max-w-2xl mx-auto">
        {WIZARD_STEPS.map((step, idx) => {
          const isDone = idx < currentIndex || current === 'done';
          const isCurrent = idx === currentIndex && current !== 'done';

          return (
            <li
              key={step.id}
              className={`flex-1 flex items-center ${
                idx < WIZARD_STEPS.length - 1 ? 'after:content-[""] after:w-full after:h-0.5 after:mx-2' : ''
              } ${
                isDone
                  ? 'after:bg-[var(--ed-status-ok)] text-[var(--ed-status-ok)]'
                  : isCurrent
                  ? 'after:bg-[var(--accent)] text-[var(--accent)]'
                  : 'after:bg-[var(--ed-rule-strong)] text-[var(--ed-ink-faint)]'
              }`}
            >
              <div className="flex flex-col items-center gap-1.5 flex-shrink-0">
                <span
                  className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold transition-all ${
                    isDone
                      ? 'bg-[var(--ed-status-ok)] text-white shadow-sm'
                      : isCurrent
                      ? 'border-2 border-[var(--accent)] text-[var(--accent)] bg-[var(--ed-accent-gold-dim)]'
                      : 'border border-[var(--ed-rule-strong)] text-[var(--ed-ink-faint)]'
                  }`}
                >
                  {isDone ? <Check size={14} /> : idx + 1}
                </span>
                <span className="text-[11px] font-medium hidden sm:inline-block">
                  {step.label}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
