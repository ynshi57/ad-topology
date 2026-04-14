/**
 * Playback timeline controller.
 * Manages current time, play/pause, speed, and scrubbing.
 */

export function createTimeline(container, { startTimeNs, endTimeNs, durationSec, onTick }) {
  const state = {
    playing: false,
    speed: 1,
    currentNs: startTimeNs,
    animId: null,
    lastFrameMs: 0,
  };

  const el = document.createElement('div');
  el.className = 'timeline';
  el.innerHTML = `
    <div class="tl-controls">
      <button class="tl-btn tl-play" id="tl-play" title="Play / Pause">
        <svg viewBox="0 0 24 24" width="16" height="16"><path id="tl-play-icon" d="M8 5v14l11-7z" fill="currentColor"/></svg>
      </button>
      <div class="tl-time">
        <span id="tl-cur">0.00</span>
        <span class="tl-sep">/</span>
        <span id="tl-dur">${durationSec.toFixed(2)}</span>
        <span class="tl-unit">s</span>
      </div>
      <div class="tl-speed-group">
        <button class="tl-speed-btn" data-speed="0.5">0.5x</button>
        <button class="tl-speed-btn active" data-speed="1">1x</button>
        <button class="tl-speed-btn" data-speed="2">2x</button>
        <button class="tl-speed-btn" data-speed="4">4x</button>
      </div>
    </div>
    <div class="tl-track-wrap">
      <div class="tl-track" id="tl-track">
        <div class="tl-progress" id="tl-progress"></div>
        <div class="tl-thumb" id="tl-thumb"></div>
      </div>
    </div>
  `;
  container.appendChild(el);

  const playBtn = el.querySelector('#tl-play');
  const playIcon = el.querySelector('#tl-play-icon');
  const curEl = el.querySelector('#tl-cur');
  const progressEl = el.querySelector('#tl-progress');
  const thumbEl = el.querySelector('#tl-thumb');
  const trackEl = el.querySelector('#tl-track');

  const totalNs = endTimeNs - startTimeNs;
  const PLAY_PATH = 'M8 5v14l11-7z';
  const PAUSE_PATH = 'M6 4h4v16H6zM14 4h4v16h-4z';

  function setProgress(ns) {
    const frac = Number(ns - startTimeNs) / Number(totalNs);
    const pct = Math.max(0, Math.min(100, frac * 100));
    progressEl.style.width = pct + '%';
    thumbEl.style.left = pct + '%';
    curEl.textContent = (Number(ns - startTimeNs) / 1e9).toFixed(2);
  }

  function tick(tsMs) {
    if (!state.playing) return;
    if (state.lastFrameMs > 0) {
      const dtMs = tsMs - state.lastFrameMs;
      const dtNs = BigInt(Math.round(dtMs * 1e6 * state.speed));
      state.currentNs = state.currentNs + dtNs;
      if (state.currentNs >= endTimeNs) {
        state.currentNs = endTimeNs;
        setProgress(endTimeNs);
        onTick(endTimeNs);
        pause();
        return;
      }
    }
    state.lastFrameMs = tsMs;
    setProgress(state.currentNs);
    onTick(state.currentNs);
    state.animId = requestAnimationFrame(tick);
  }

  function play() {
    if (state.currentNs >= endTimeNs) {
      state.currentNs = startTimeNs;
      setProgress(startTimeNs);
    }
    state.playing = true;
    state.lastFrameMs = 0;
    playIcon.setAttribute('d', PAUSE_PATH);
    playBtn.classList.add('playing');
    state.animId = requestAnimationFrame(tick);
  }

  function pause() {
    state.playing = false;
    playIcon.setAttribute('d', PLAY_PATH);
    playBtn.classList.remove('playing');
    if (state.animId) cancelAnimationFrame(state.animId);
  }

  playBtn.addEventListener('click', () => {
    if (state.playing) { pause(); } else { play(); }
  });

  // Speed buttons
  el.querySelectorAll('.tl-speed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      el.querySelectorAll('.tl-speed-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.speed = parseFloat(btn.dataset.speed);
    });
  });

  // Scrub
  let dragging = false;
  function scrubFromEvent(e) {
    const rect = trackEl.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const ns = startTimeNs + BigInt(Math.round(frac * Number(totalNs)));
    state.currentNs = ns;
    setProgress(ns);
    onTick(ns);
  }

  trackEl.addEventListener('pointerdown', (e) => {
    dragging = true;
    trackEl.setPointerCapture(e.pointerId);
    const wasPlaying = state.playing;
    if (wasPlaying) pause();
    scrubFromEvent(e);
    trackEl._wasPlaying = wasPlaying;
  });
  trackEl.addEventListener('pointermove', (e) => { if (dragging) scrubFromEvent(e); });
  trackEl.addEventListener('pointerup', () => {
    dragging = false;
    if (trackEl._wasPlaying) play();
  });

  setProgress(startTimeNs);

  return {
    play, pause,
    seek(ns) { state.currentNs = ns; setProgress(ns); onTick(ns); },
    getState: () => ({ ...state }),
    destroy() { pause(); el.remove(); },
  };
}
