// Landing page after connecting Google from the extension. Explains any permission Google did not grant.
const missing = new URLSearchParams(location.search).get('missing');
if (missing) {
  document.getElementById('connected-title').textContent = 'Google is connected, with some permissions off.';
  document.getElementById('connected-detail').textContent = `Google did not grant: ${missing.replace(/_/g, ' ').replace(/,/g, ', ')}. Those features stay off; you can add them from your PigeonBox dashboard any time.`;
}
