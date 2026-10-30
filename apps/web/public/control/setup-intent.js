// Someone started switching to their PigeonBox server and agreed to send
// mail to it. Kept for the trip through sign-in, so setup can finish on its
// own when they come back. Expires after a day.
const KEY = 'pigeonbox.cloudSetup';
const TTL_MS = 24 * 60 * 60 * 1000;

export function readIntent() {
  try {
    const intent = JSON.parse(localStorage.getItem(KEY) || 'null');
    return intent?.consent === true && typeof intent.userId === 'string' && Number.isFinite(intent.at) && Date.now() >= intent.at && Date.now() - intent.at < TTL_MS ? intent : null;
  } catch {
    return null;
  }
}

export function writeIntent(userId) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ consent: true, userId, at: Date.now() }));
  } catch {
    // Storage blocked: setup asks again after each trip.
  }
}

export function clearIntent() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing stored.
  }
}
