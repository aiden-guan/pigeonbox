/**
 * Protocol versioning between the PigeonBox extension and a PigeonBox server.
 *
 * Compatibility rules:
 * - `PROTOCOL_VERSION` is a major version. It changes only for breaking changes:
 *   a removed route, a renamed field, a field whose meaning changes, or a field that
 *   becomes required in a request.
 * - Additive changes keep the version: new routes, new optional request fields,
 *   new response fields, new capabilities, new error codes.
 * - Clients ignore response fields and capabilities they do not know.
 * - The server accepts every version listed in `supported` and rejects others with
 *   `unsupported_protocol` (HTTP 426), so an old extension gets a clear message.
 */
export const PROTOCOL_VERSION = 1;

/** Sent on every Cloud request by the client. */
export const PROTOCOL_HEADER = 'x-pigeonbox-protocol';
/** `extension/<version>` or `web/<version>`. Informational only; never used for auth. */
export const CLIENT_HEADER = 'x-pigeonbox-client';
/** Echoed on every response so users can quote it in support requests. */
export const REQUEST_ID_HEADER = 'x-request-id';

export function isSupportedProtocol(value: string | null | undefined, supported: readonly number[]): boolean {
  if (!value) return false;
  const version = Number(value);
  return Number.isInteger(version) && supported.includes(version);
}
