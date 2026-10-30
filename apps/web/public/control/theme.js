/**
 * Dashboard appearance, applied before first paint and saved in this browser.
 * Pull the lamp chain down and release, or click / press Enter or Space.
 */
(() => {
  const KEY = 'pigeonboxAppearance';
  const COLOR = { light: '#f3f0e8', dark: '#111214' };
  const root = document.documentElement;
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const scheme = matchMedia('(prefers-color-scheme: dark)');
  const read = () => {
    try {
      const value = localStorage.getItem(KEY);
      return value === 'dark' || value === 'system' ? value : 'light';
    } catch { return 'light'; }
  };
  // Honour saved system preferences from the old three-way switch.
  const effective = (value) => value === 'system' ? (scheme.matches ? 'dark' : 'light') : value;
  let current = 'light';
  const apply = (value) => {
    current = value;
    root.dataset.pbThemeSwitching = '';
    root.dataset.pbTheme = value;
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
      meta.content = COLOR[effective(value)];
    }
    void root.offsetHeight;
    requestAnimationFrame(() => requestAnimationFrame(() => { delete root.dataset.pbThemeSwitching; }));
    const lamp = document.getElementById('cp-theme');
    if (lamp) {
      lamp.setAttribute('aria-pressed', String(effective(value) === 'dark'));
      lamp.title = effective(value) === 'dark' ? 'Pull for light mode' : 'Pull for dark mode';
    }
  };
  const flip = () => {
    const next = effective(current) === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(KEY, next); } catch { /* Still works for this visit. */ }
    apply(next);
  };
  apply(read());
  window.addEventListener('storage', (event) => {
    if (event.key === KEY || event.key === null) apply(read());
  });
  scheme.addEventListener('change', () => { if (current === 'system') apply(current); });

  document.addEventListener('DOMContentLoaded', () => {
    apply(current);
    const lamp = document.getElementById('cp-theme');
    const swing = lamp?.querySelector('.cp-lamp-swing');
    const drop = lamp?.querySelector('.cp-lamp-drop');
    if (!lamp || !swing || !drop) return;

    const REACH = 38;
    const THRESHOLD = 15;
    let pull = 0, pullV = 0, angle = 0, angleV = 0;
    let drag = null, frame = 0, lastFrame = 0;
    const paint = () => {
      swing.style.transform = motion.matches ? 'none' : `rotate(${angle.toFixed(3)}deg)`;
      drop.style.transform = motion.matches ? 'none' : `translateY(${pull.toFixed(2)}px)`;
      lamp.toggleAttribute('data-armed', Boolean(drag) && pull >= THRESHOLD);
    };
    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
    };
    const reset = () => {
      stop();
      pull = pullV = angle = angleV = 0;
      paint();
    };
    const tick = (now) => {
      // Integrate in seconds so 60/120 Hz displays feel the same. Small steps
      // keep the spring stable after a slow frame; background time is ignored.
      let remaining = Math.min((now - lastFrame) / 1000, 0.032);
      lastFrame = now;
      while (remaining > 0) {
        const dt = Math.min(remaining, 1 / 120);
        pullV += (-360 * pull - 25 * pullV) * dt;
        pull += pullV * dt;
        angleV += (-105 * angle - 14 * angleV) * dt;
        angle += angleV * dt;
        remaining -= dt;
      }
      paint();
      if (Math.abs(pull) < 0.05 && Math.abs(pullV) < 0.3 && Math.abs(angle) < 0.05 && Math.abs(angleV) < 0.3) {
        reset();
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    const run = () => {
      if (motion.matches) { reset(); return; }
      if (!frame) {
        lastFrame = performance.now();
        frame = requestAnimationFrame(tick);
      }
    };
    const tug = (animate = true) => {
      flip();
      if (!animate || motion.matches) { reset(); return; }
      pullV = 460;
      angleV += angle >= 0 ? 24 : -24;
      run();
    };
    lamp.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !event.isPrimary || drag) return;
      stop();
      lamp.setPointerCapture(event.pointerId);
      drag = {
        id: event.pointerId, x: event.clientX, y: event.clientY,
        startPull: pull, startAngle: angle, moved: 0,
        lastX: event.clientX, lastT: performance.now(), vx: 0,
      };
      pullV = angleV = 0;
      lamp.setAttribute('data-dragging', '');
    });
    lamp.addEventListener('pointermove', (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      drag.moved = Math.max(drag.moved, Math.hypot(dx, dy));
      pull = Math.max(-5, Math.min(REACH, drag.startPull + (dy > 0 ? REACH * (1 - Math.exp(-dy / REACH)) : dy * 0.15)));
      angle = Math.max(-22, Math.min(22, drag.startAngle - Math.atan2(dx * 0.6, 34 + pull) * 180 / Math.PI));
      const now = performance.now();
      drag.vx = (event.clientX - drag.lastX) / Math.max(1, now - drag.lastT);
      drag.lastX = event.clientX;
      drag.lastT = now;
      paint();
    });
    const release = (event, cancelled = false) => {
      if (!drag || drag.id !== event.pointerId) return;
      const released = drag;
      drag = null;
      lamp.removeAttribute('data-dragging');
      if (lamp.hasPointerCapture(event.pointerId)) lamp.releasePointerCapture(event.pointerId);
      if (!cancelled && released.moved < 4) { tug(); return; }
      if (!cancelled && pull >= THRESHOLD) flip();
      // Only a recent sideways motion adds momentum; clamp wild flings.
      angleV = performance.now() - released.lastT < 80 ? Math.max(-90, Math.min(90, -released.vx * 65)) : 0;
      paint();
      run();
    };
    lamp.addEventListener('pointerup', (event) => release(event));
    lamp.addEventListener('pointercancel', (event) => release(event, true));
    lamp.addEventListener('lostpointercapture', (event) => release(event, true));
    // Pointer releases are handled above. Native keyboard/assistive clicks
    // toggle immediately without decorative motion.
    lamp.addEventListener('click', (event) => { if (event.detail === 0) tug(false); });
    const cancel = () => {
      if (drag) release({ pointerId: drag.id }, true);
      reset();
    };
    motion.addEventListener('change', cancel);
    window.addEventListener('blur', cancel);
    document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); });
  });
})();
