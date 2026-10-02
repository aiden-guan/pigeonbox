import type { OrbTone } from './orb-markup';
import { DotField } from './DotField';

export function Orb({ size = 16, tone = 'paper' }: { size?: number; tone?: OrbTone }) {
  return <DotField state="analyzing" size={size} onAccent={tone === 'on-accent'} />;
}
