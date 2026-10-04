/**
 * Audio feedback for scans. Uses Web Audio (no asset file, no HTMLAudio
 * unlock quirks); failures are swallowed — audio feedback must never break a
 * scan. The AudioContext may start suspended until the first user gesture;
 * resume() is attempted on every play so it unlocks as soon as the operator
 * has tapped anything (e.g. login).
 */
let ctx: AudioContext | null = null;

function playTone(frequency: number, durationMs: number, delayMs = 0): void {
  try {
    if (typeof window === 'undefined') return;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    ctx ??= new Ctor();
    if (ctx.state === 'suspended') void ctx.resume();
    const start = ctx.currentTime + delayMs / 1000;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.06, start);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + durationMs / 1000);
  } catch {
    // best-effort feedback only
  }
}

/** Short high beep — scan accepted. */
export function playScanSuccess(): void {
  playTone(2600, 80);
}

/** Low double buzz — scan rejected or not matched. */
export function playScanError(): void {
  playTone(400, 140);
  playTone(400, 140, 190);
}
