import type { ReactNode } from 'react';
import type { VoiceProfile } from '@pigeonbox/shared';

const SIGNOFFS = ['Thanks', 'Best', 'Best regards', 'Cheers'];

/** What drafts need to write as the user: who they are and how they sign. */
export function ProfileFields(props: { voice: VoiceProfile; onChange: (voice: VoiceProfile) => void }) {
  const { voice, onChange } = props;
  const set = <K extends keyof VoiceProfile>(key: K, value: VoiceProfile[K]) => onChange({ ...voice, [key]: value });

  return (
    <div className="flex flex-col gap-4">
      <Labeled label="Your name" hint="Drafts are signed with it.">
        <input
          className="gi-field"
          value={voice.name}
          aria-label="Your name"
          placeholder="Alex"
          autoComplete="given-name"
          onChange={(event) => set('name', event.target.value)}
        />
      </Labeled>
      <Labeled label="About you" hint="Optional. Helps drafts sound like they come from you.">
        <input
          className="gi-field"
          value={voice.about}
          aria-label="About you"
          placeholder="CS student at UC Berkeley"
          maxLength={160}
          onChange={(event) => set('about', event.target.value)}
        />
      </Labeled>
      <Labeled label="Sign-off">
        <div className="flex flex-wrap gap-1.5">
          {SIGNOFFS.map((signoff) => (
            <button
              key={signoff}
              type="button"
              className="gi-chip-btn"
              data-active={voice.signoff === signoff}
              onClick={() => set('signoff', signoff)}
            >
              {signoff}
            </button>
          ))}
          <input
            className="gi-field min-w-0 flex-1"
            value={SIGNOFFS.includes(voice.signoff) ? '' : voice.signoff}
            placeholder="Other"
            aria-label="Custom sign-off"
            onChange={(event) => set('signoff', event.target.value)}
          />
        </div>
      </Labeled>
      <Labeled label="Tone">
        <Segments
          value={voice.formality}
          options={[['casual', 'Casual'], ['neutral', 'Neutral'], ['formal', 'Formal']]}
          onChange={(value) => set('formality', value)}
        />
      </Labeled>
      <Labeled label="Length">
        <Segments
          value={voice.concision}
          options={[['short', 'Short'], ['medium', 'Medium'], ['long', 'Long']]}
          onChange={(value) => set('concision', value)}
        />
      </Labeled>
    </div>
  );
}

function Segments<T extends string>(props: { value: T; options: Array<[T, string]>; onChange: (value: T) => void }) {
  return (
    <div className="gi-segbar w-fit" role="radiogroup">
      {props.options.map(([value, label]) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={props.value === value}
          className="gi-seg"
          data-active={props.value === value}
          onClick={() => props.onChange(value)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Labeled(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="block text-xs text-[color:var(--pb-fg-muted)]">
      <div>{props.label}</div>
      <div className="mt-1.5">{props.children}</div>
      {props.hint ? <div className="gi-muted mt-1 text-[11px]">{props.hint}</div> : null}
    </div>
  );
}
