let ctx: AudioContext | null = null;
let unlockBound = false;

/**
 * Two-tone chime for in-app alert toasts — WebAudio, no asset to ship.
 * Browsers gate AudioContext behind a user gesture: if it's still suspended
 * (no interaction yet), arm a one-time unlock and skip this chime.
 */
export function playAlertSound(): void {
  try {
    ctx ??= new AudioContext();
  } catch {
    return; // no WebAudio — nothing to play
  }
  const c = ctx;
  if (c.state === 'suspended') {
    if (!unlockBound) {
      unlockBound = true;
      const unlock = () => void c.resume();
      window.addEventListener('pointerdown', unlock, { once: true });
      window.addEventListener('keydown', unlock, { once: true });
    }
    return;
  }
  const t0 = c.currentTime;
  for (const [freq, start] of [
    [880, 0],
    [660, 0.13],
  ] as const) {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0 + start);
    gain.gain.exponentialRampToValueAtTime(0.12, t0 + start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + 0.3);
    osc.connect(gain).connect(c.destination);
    osc.start(t0 + start);
    osc.stop(t0 + start + 0.35);
  }
}
