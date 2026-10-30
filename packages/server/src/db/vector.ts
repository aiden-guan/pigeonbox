/** Shared pgvector parameter encoding. Non-finite model output is never SQL. */
export function vectorLiteral(vector: number[]): string {
  return `[${vector.map((value) => (Number.isFinite(value) ? value.toFixed(6) : '0')).join(',')}]`;
}
