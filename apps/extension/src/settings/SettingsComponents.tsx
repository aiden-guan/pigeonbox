import type { ReactNode } from 'react';
export function Section(props: { title: string; children: ReactNode; id?: string }) {
  return (
    <section className="gi-card" id={props.id}>
      <h2>{props.title}</h2>
      <div className="space-y-3">{props.children}</div>
    </section>
  );
}

export function Toggle(props: { label: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-[13px]">{props.label}</span>
      <button
        type="button"
        className="gi-toggle"
        role="switch"
        aria-checked={props.checked}
        aria-label={props.label}
        onClick={() => props.onChange(!props.checked)}
      >
        <span />
      </button>
    </div>
  );
}

export function Field(props: { label: string; children: ReactNode }) {
  return (
    <label className="block text-xs text-[#aba99e]">
      {props.label}
      <div className="mt-1.5">{props.children}</div>
    </label>
  );
}
