import { Orb } from './Orb';
import type { OrbState } from './orb-markup';

// Compatibility for existing intelligence/status consumers. One motion system.
export type DotState = OrbState;
export function DotField({ state = 'idle', size = 24, onAccent = false }: { state?: DotState; size?: number; onAccent?: boolean }) {
  return <Orb state={state} size={size} tone={onAccent ? 'on-accent' : 'bare'} />;
}
