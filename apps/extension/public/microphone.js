// Grants the microphone to the extension once. Ask Pigeon's frames cannot show Chrome's permission prompt themselves.
const status = document.getElementById('status');
const button = document.getElementById('allow');
async function allow() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    status.textContent = 'Microphone allowed. You can close this tab and tap the mic in Ask Pigeon.';
    button.hidden = true;
    setTimeout(() => window.close(), 1500);
  } catch {
    status.textContent = 'Chrome blocked the microphone. Click the icon at the right of the address bar to allow it, then try again.';
  }
}
button.addEventListener('click', allow);
navigator.permissions?.query({ name: 'microphone' }).then((state) => { if (state.state !== 'denied') void allow(); }).catch(() => undefined);
