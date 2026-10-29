// A stand-in for the PigeonBox extension's dashboard bridge, installed before
// the page loads (Playwright addInitScript). It answers the same messages as
// apps/extension/src/background/web-bridge.ts, with state kept in
// sessionStorage so it survives reloads and sign-in redirects.
(() => {
  const KEY = 'fake-extension';
  const initial = {
    runMode: 'local',
    cloud: { status: 'signed_out', email: null, capabilities: [] },
    settings: {
      runMode: 'local', trackingEnabled: true, trackOpens: true, trackLinks: true, desktopNotifications: true, hideSuspectedSelfOpens: true,
      trackerBaseUrl: '', hasPersonalApiToken: false, hasAiApiKey: false, aiMode: 'disabled', aiProvider: 'openai', aiModel: 'gpt-4o-mini',
      aiEndpoint: 'https://api.openai.com/v1', autoClassify: true, autoSummarize: true, autoDraft: false, autoInsertDraft: false, autoReminders: true,
      autoArchive: false, archiveCategories: ['NOTIFICATIONS', 'PROMOTIONS', 'NEWS'], archiveConfidenceThreshold: 0.95, alwaysArchiveSenders: [], neverArchiveSenders: [],
      reminderMode: 'ai_needed', reminderBusinessDays: 3, commandPaletteEnabled: true, commandPaletteOverrideGmail: false, learnFromSent: false,
      voiceProfile: { name: '', about: '', greeting: 'Hi', signoff: 'Thanks', concision: 'medium', capitalization: 'normal', formality: 'neutral', emoji: false, schedulingPreference: '', personalInstructions: '' },
    },
    rules: [],
    link: null,
    log: [],
  };
  const read = () => JSON.parse(sessionStorage.getItem(KEY) || 'null') ?? structuredClone(initial);
  const write = (state) => sessionStorage.setItem(KEY, JSON.stringify(state));
  const product = (state) => ({
    runMode: state.runMode,
    cloudAvailable: true,
    cloudConsentAt: null,
    cloud: state.cloud,
    capabilities: state.runMode === 'cloud' ? state.cloud.capabilities : ['ask_inbox'],
    aiDestination: state.runMode === 'cloud' ? 'pigeonbox_cloud' : state.settings.aiMode === 'disabled' ? 'none' : 'your_provider',
    experimental: false,
    cloudOrigins: state.cloudOrigins ?? [],
  });

  async function handle(message) {
    const state = read();
    state.log.push(message.type);
    let reply;
    switch (message.type) {
      case 'HELLO':
        reply = { ok: true, extensionId: 'abcdefghijklmnopabcdefghijklmnop', version: '0.6.0', storeInstall: true, apiBaseUrl: location.origin, product: product(state), accountLink: true, account: state.accountSession?.user ?? null, settingsSync: state.settingsSync ?? null };
        break;
      case 'GET_SETTINGS':
        reply = { ok: true, settings: state.settings, rules: state.rules, missingOrigins: [], product: product(state) };
        break;
      case 'SAVE_SETTINGS': {
        const { aiApiKey, personalApiToken, runMode, ...rest } = message.settings;
        Object.assign(state.settings, rest);
        if (typeof personalApiToken === 'string') state.settings.hasPersonalApiToken = Boolean(personalApiToken);
        if (typeof aiApiKey === 'string') state.settings.hasAiApiKey = Boolean(aiApiKey);
        reply = { ok: true, settings: state.settings, missingOrigins: [] };
        break;
      }
      case 'SAVE_RULES':
        state.rules = message.lines;
        reply = { ok: true, rules: state.rules };
        break;
      case 'SETTINGS_SYNCED':
        state.settingsSync = { userId: message.userId, at: new Date().toISOString() };
        reply = { ok: true, settingsSync: state.settingsSync };
        break;
      case 'SET_RUN_MODE':
        if (message.mode === 'cloud' && message.consent !== true) reply = { ok: false, reason: 'Server mode needs your agreement.' };
        else {
          state.runMode = message.mode;
          state.settings.runMode = message.mode;
          reply = { ok: true, product: product(state) };
        }
        break;
      case 'LINK_BEGIN': {
        const verifier = Array.from(crypto.getRandomValues(new Uint8Array(48)), (b) => (b % 36).toString(36)).join('');
        const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
        const challenge = btoa(String.fromCharCode(...hash)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        state.link = { state: crypto.randomUUID().replace(/-/g, ''), verifier, redirectUri: message.redirectUri };
        reply = { ok: true, codeChallenge: challenge, state: state.link.state, apiBaseUrl: location.origin };
        break;
      }
      case 'LINK_COMPLETE':
        if (!state.link || message.state !== state.link.state) reply = { ok: false, reason: 'Connecting PigeonBox could not be verified. Start again.' };
        else if (state.cloudOrigins?.length && !state.granted) reply = { ok: false, reason: 'Could not reach your PigeonBox server.' };
        else {
          const pending = state.link;
          state.link = null;
          const response = await fetch('/v1/auth/token', { method: 'POST', headers: { 'x-pigeonbox-protocol': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ code: message.code, codeVerifier: pending.verifier, redirectUri: pending.redirectUri }) });
          const session = await response.json();
          if (!response.ok) reply = { ok: false, reason: session.error?.message };
          else {
            state.accountSession = session;
            // The extension is ready when the server grants hosted AI (apps/extension/src/background/cloud/client.ts).
            const allowed = window.__fakeNoAccess !== true;
            state.cloud = { status: allowed ? 'ready' : 'not_entitled', email: session.user.email, capabilities: allowed ? ['cloud_ai', 'cloud_mail_sync', 'cloud_tracking'] : [] };
            reply = { ok: true, user: session.user, product: product(state) };
          }
        }
        break;
      case 'ACCOUNT_LINK': {
        if (!state.accountSession) { reply = { ok: false, code: 'signed_out', reason: 'Sign in to your PigeonBox account.' }; break; }
        const response = await fetch('/v1/auth/link', { method: 'POST', headers: { 'x-pigeonbox-protocol': '1', 'Content-Type': 'application/json', Authorization: `Bearer ${state.accountSession.accessToken}` }, body: JSON.stringify({ redirect_uri: message.redirectUri, code_challenge: message.codeChallenge, code_challenge_method: 'S256', state: message.state }) });
        const data = await response.json();
        reply = response.ok ? { ok: true, ...data } : { ok: false, code: data.error?.code, reason: data.error?.message };
        break;
      }
      case 'REFRESH':
      case 'SIGN_OUT':
        reply = { ok: true, product: product(state) };
        break;
      case 'ACTION':
        reply = { ok: true, result: null };
        break;
      case 'GRANT':
        if (window.__fakeDenyGrant !== true) state.granted = true;
        reply = { ok: true, granted: Boolean(state.granted) };
        break;
      case 'CHECK_ORIGINS':
        reply = { ok: true, granted: !state.cloudOrigins?.length || Boolean(state.granted) };
        break;
      case 'BYE':
        reply = { ok: true };
        break;
      default:
        reply = { ok: false, reason: 'Unknown request.' };
    }
    write(state);
    return reply;
  }

  window.chrome = window.chrome || {};
  window.chrome.runtime = {
    lastError: undefined,
    sendMessage(id, message, callback) {
      setTimeout(() => {
        if (id !== 'abcdefghijklmnopabcdefghijklmnop') return callback(undefined);
        void handle(message).then(callback).catch((error) => callback({ ok: false, reason: error.message }));
      }, 5);
    },
  };
  window.__fakeExtension = { read, write, reset: () => sessionStorage.removeItem(KEY) };
})();
