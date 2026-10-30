const KEY = 'pigeonbox.mcp.authorization';
let memory = null;
const id = new URLSearchParams(location.search).get('authorization_id');
if (id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
  memory = id;
  try { sessionStorage.setItem(KEY, id); } catch { /* Use this tab's memory. */ }
}
export function pendingMcpAuthorization() {
  try { return sessionStorage.getItem(KEY) || memory; } catch { return memory; }
}
export function clearMcpAuthorization() {
  memory = null;
  try { sessionStorage.removeItem(KEY); } catch { /* Storage unavailable. */ }
}
