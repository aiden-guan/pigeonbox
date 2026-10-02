import type { ReactNode } from 'react';
export function Section(props: { title: string; children: ReactNode; id?: string }) {
  return (
    <section className="gi-card" id={props.id}>
      <h2>{props.title}</h2>
      <div className="space-y-3">{props.children}</div>
    </section>
  );
}

export function Toggle(props: { label: string; description?: string; checked: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
  const describedBy = props.description ? `toggle-${props.label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}` : undefined;
  return (
    <div className="flex items-center justify-between gap-4" data-disabled={props.disabled || undefined}>
      <span className="grid gap-0.5">
        <span className="text-[13px]">{props.label}</span>
        {props.description ? <span id={describedBy} className="gi-muted text-[12px] leading-snug">{props.description}</span> : null}
      </span>
      <button
        type="button"
        className="gi-toggle shrink-0"
        role="switch"
        aria-checked={props.checked}
        aria-label={props.label}
        aria-describedby={describedBy}
        disabled={props.disabled}
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
