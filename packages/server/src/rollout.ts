/**
 * Server-side rollout and kill switches for features the installed extension
 * already understands. This sits under capabilities, not beside them: the server's
 * configuration grants a capability (`entitlements.ts`), and a rollout stage decides whether
 * one optional AI behavior inside that capability runs for a person. Turning a
 * feature off never removes a capability, never changes a response shape, and
 * never needs a client release; the server simply does less (a compose check
 * answers `disabled`, a background job is skipped).
 *
 * Configuration is plain data in Worker vars (auditable in wrangler.toml and
 * Cloudflare's version history), parsed once per isolate:
 *
 *   CLOUD_ROLLOUT="compose_semantic=early_beta,auto_drafts=off"
 *   CLOUD_INTERNAL_USER_IDS="<uuid>,…"      owner/internal cohort
 *   CLOUD_EARLY_BETA_USER_IDS="<uuid>,…"    early beta cohort
 *
 * Every other entitled person is in `beta`. A feature not listed is at `beta`,
 * so an empty CLOUD_ROLLOUT changes nothing. An unrecognized stage turns that
 * feature off (a typo in an emergency disable must not leave it on) and is
 * reported in `invalid` for the startup log. Unknown feature names are ignored
 * and reported. No expressions, no remote code: a feature, a stage, a cohort.
 */

export const ROLLOUT_FEATURES = [
  /** Real-time Pidgy compose checks (`/v1/compose/check` notices). */
  'compose_checks',
  /** Semantic (embedding) retrieval inside compose checks; exact/current-thread checks stay. */
  'compose_semantic',
  /** Smart compose completions. */
  'compose_completion',
  /** Background memory learning (`memory.extract`). Existing memories stay readable. */
  'memory_learning',
  /** Auto-prepared reply and scheduling drafts after analysis. */
  'auto_drafts',
  /** Drafts prepared when a follow-up comes due; the follow-up alert itself still fires. */
  'followup_drafts',
  /** Scheduled morning and end-of-day briefings; a briefing the person asks for still runs. */
  'briefings',
] as const;
export type RolloutFeature = (typeof ROLLOUT_FEATURES)[number];

/** Ordered from narrowest to widest. */
export const ROLLOUT_STAGES = ['off', 'internal', 'early_beta', 'beta'] as const;
export type RolloutStage = (typeof ROLLOUT_STAGES)[number];
export type RolloutCohort = Exclude<RolloutStage, 'off'>;

export type RolloutConfig = {
  stages: Record<RolloutFeature, RolloutStage>;
  internal: ReadonlySet<string>;
  earlyBeta: ReadonlySet<string>;
  /** Entries that were not understood, for one startup warning. Never user IDs. */
  invalid: string[];
};

const ids = (value: string | undefined) =>
  new Set(
    (value ?? '')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter((item) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item)),
  );

export function parseRollout(env: { CLOUD_ROLLOUT?: string; CLOUD_INTERNAL_USER_IDS?: string; CLOUD_EARLY_BETA_USER_IDS?: string }): RolloutConfig {
  const stages = Object.fromEntries(ROLLOUT_FEATURES.map((feature) => [feature, 'beta'])) as Record<RolloutFeature, RolloutStage>;
  const invalid: string[] = [];
  for (const entry of (env.CLOUD_ROLLOUT ?? '').split(',').map((item) => item.trim()).filter(Boolean)) {
    const [name = '', value = ''] = entry.split('=').map((part) => part.trim().toLowerCase());
    if (!(ROLLOUT_FEATURES as readonly string[]).includes(name)) {
      invalid.push(name.slice(0, 40) || 'empty');
      continue;
    }
    if ((ROLLOUT_STAGES as readonly string[]).includes(value)) stages[name as RolloutFeature] = value as RolloutStage;
    else {
      // Fail closed for this one feature only.
      stages[name as RolloutFeature] = 'off';
      invalid.push(name);
    }
  }
  return { stages, internal: ids(env.CLOUD_INTERNAL_USER_IDS), earlyBeta: ids(env.CLOUD_EARLY_BETA_USER_IDS), invalid };
}

export function cohortOf(rollout: Pick<RolloutConfig, 'internal' | 'earlyBeta'>, userId: string): RolloutCohort {
  const id = userId.toLowerCase();
  if (rollout.internal.has(id)) return 'internal';
  if (rollout.earlyBeta.has(id)) return 'early_beta';
  return 'beta';
}

/** True when `feature` runs for this person. Deterministic: same config and user, same answer. */
export function featureEnabled(rollout: RolloutConfig | undefined, feature: RolloutFeature, userId: string): boolean {
  // No rollout config at all (older test configs): everything stays as it was.
  if (!rollout) return true;
  const stage = rollout.stages[feature] ?? 'beta';
  if (stage === 'off') return false;
  return ROLLOUT_STAGES.indexOf(cohortOf(rollout, userId)) <= ROLLOUT_STAGES.indexOf(stage);
}

/** Content-free summary for logs and operators: stages only, never cohort membership. */
export function describeRollout(rollout: RolloutConfig): Record<RolloutFeature, RolloutStage> {
  return { ...rollout.stages };
}
