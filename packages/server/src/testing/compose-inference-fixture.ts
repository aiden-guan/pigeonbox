/** Convert legacy scenario judgments into the model's compact wire shape.
 * Invalid IDs and uncited messages remain invalid; this never supplies proof. */
export function composeInferenceFixture(value: Record<string, unknown>, evidence: Array<{ id: string; advisories?: string[] }>): Record<string, unknown> {
  if ('advisory' in value) return value;
  const ids = Array.isArray(value.sourceIds) ? value.sourceIds as string[] : [];
  const messageSource = evidence.find(item => ids.includes(item.id) && item.advisories?.includes(String(value.message)));
  return {
    advisory: value.surface ? {
      kind: value.kind,
      confidence: value.confidence,
      sourceIds: messageSource ? [messageSource.id, ...ids.filter(id => id !== messageSource.id)] : ids,
      advisoryIndex: messageSource?.advisories?.indexOf(String(value.message)) ?? -1,
      suggestedText: value.suggestedText ?? null,
      highlightText: value.highlightText ?? null,
    } : null,
    completion: value.completion ?? null,
    writing: value.writing ?? null,
  };
}
