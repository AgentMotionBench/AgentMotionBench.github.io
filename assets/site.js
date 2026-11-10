/* AgentMotionBench paper site. Everything shown comes from data.js (bench/build_site.py); labels are inserted with
   textContent. One compare.mp4 per run is drawn into three canvases (input | ground truth | agent), so the panels
   are always on the same frame; the error curve under them is the scrubber. */
(() => {
  'use strict';
  const D = window.AMB_DATA;
  if (!D) return;

  const NS = 'http://www.w3.org/2000/svg';
  const runs = new Map(D.runs.map(r => [r.id, r]));
  const exps = new Map(D.experiments.map(e => [e.id, e]));
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (s, root = document) => root.querySelector(s);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const pct = (v, d = 1) => (v == null ? '–' : v.toFixed(d));

  function el(tag, props, ...kids) {
    const e = document.createElement(tag);
    if (props) for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k != null) e.append(k);
    return e;
  }
  function sv(tag, attrs, ...kids) {
    const e = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    for (const k of kids) if (k != null) e.append(k);
    return e;
  }
  const icon = d => sv('svg', { viewBox: '0 0 16 16', class: 'ico', 'aria-hidden': 'true' }, sv('path', { d }));
  const agentLine = r => [r.modelName || r.model || 'unknown model', r.effort ? r.effort + ' effort' : null].filter(Boolean).join(' · ');
  const score = v => (v == null ? '\u2013' : v.toFixed(0)); // skill score, 0 to 100
  const isMain = r => r.protocol === 'web';
  // What a reader must know before reading a score: which protocol, and whether calibration was handed over.
  function protocolPhrase(r) {
    if (isMain(r)) return 'main protocol';
    const e = exps.get(r.exp), c = r.condition != null && e ? e.conditions[r.condition] : null;
    return 'earlier protocol' + (c && c.given.some(g => /calibration|intrinsics/i.test(g)) ? ', camera calibration given' : '');
  }

  // ------------------------------------------------------------------------------------------------ poster cache
  const posterCache = new Map();
  function poster(run) {
    if (!run.poster) return Promise.resolve(null);
    if (!posterCache.has(run.id)) {
      posterCache.set(run.id, new Promise(res => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = () => res(null);
        im.src = run.poster;
      }));
    }
    return posterCache.get(run.id);
  }

  // Source rectangle (pixels) of a panel inside a compare frame, optionally cropped to a box given in panel fractions.
  function srcRect(sw, sh, rect, box) {
    const b = box || [0, 0, 1, 1];
    const rw = rect[2] * sw, rh = rect[3] * sh;
    return [rect[0] * sw + b[0] * rw + 0.75, rect[1] * sh + b[1] * rh + 0.75, b[2] * rw - 1.5, b[3] * rh - 1.5];
  }
  const LEGEND_ZONE = [0.44, 0.86, 0.56, 0.11]; // burned-in colour bar, panel fractions (bench/viz_extras.legend)

  // ------------------------------------------------------------------------------------------------ the figure
  const players = new Set();

  class Scrub {
    constructor(root, { eager = false } = {}) {
      this.root = root;
      this.eager = eager;
      this.run = null;
      this.view = 0;
      this.frame = 0;
      this.playing = false;
      this.wantPlay = false;
      this.videoReady = false;
      this.canvas = {};
      this.msg = {};
      this.note = {};
      players.add(this);

      const panel = (k, title, keyClass) => {
        const canvas = el('canvas', { 'aria-hidden': 'true' });
        const msg = el('p', { class: 'fr-msg', hidden: true });
        const note = el('span', { class: 'note' });
        this.canvas[k] = canvas; this.msg[k] = msg; this.note[k] = note;
        const cap = el('figcaption', null, el('i', { class: 'key ' + keyClass }), el('b', { text: title }), note);
        const frame = el('div', { class: 'fr' }, canvas, msg);
        if (k === 'ag') { // sits exactly over the colour bar burned into the footage, so one crisp scale shows on every clip
          this.scale = el('span', { class: 'scale', title: 'Surface error: blue is 0, red is 10 % of body size or more' },
            el('span', null, el('span', { class: 'w', text: 'error ' }), '0'), el('i'), el('span', { text: '10 %+' }));
          frame.append(this.scale);
        }
        return el('figure', { class: 'pn pn-' + k }, cap, frame);
      };
      this.tri = el('div', { class: 'tri' }, panel('in', 'Input video', 'key-in'), panel('gt', 'Ground truth', 'key-gt'), panel('ag', 'Agent', 'key-ag'));

      this.playBtn = el('button', { class: 'play', type: 'button', 'aria-label': 'Play', onclick: () => this.toggle() },
        sv('svg', { viewBox: '0 0 16 16', class: 'i-play', 'aria-hidden': 'true' }, sv('path', { d: 'M5 2.8v10.4L13.2 8z' })),
        sv('svg', { viewBox: '0 0 16 16', class: 'i-pause', 'aria-hidden': 'true' }, sv('path', { d: 'M4 3h3v10H4zM9 3h3v10H9z' })));
      this.svg = sv('svg', { 'aria-hidden': 'true' });
      this.tip = el('div', { class: 'tip', hidden: true });
      this.plot = el('div', { class: 'plot', role: 'slider', tabindex: '0', 'aria-label': 'Frame; the curve shows surface error over time' }, this.svg, this.tip);
      this.readVal = el('b');
      this.readMain = el('div', { class: 'read-main' }, el('i', { class: 'key key-line key-ag' }), this.readVal, el('span', { text: 'of body size' }));
      this.readRef = el('span');
      this.readRefRow = el('div', { class: 'read-sub' }, el('i', { class: 'key key-line key-ref' }), this.readRef);
      this.readFrame = el('span');
      this.worstBtn = el('button', { class: 'link-btn', type: 'button', text: 'worst frame', title: 'Jump to the frame with the largest error', onclick: () => this.seek(this.worst, true) });
      this.readSub = el('div', { class: 'read-sub' }, this.readFrame, this.worstBtn);
      this.scrub = el('div', { class: 'scrub' }, this.playBtn, this.plot, el('div', { class: 'read' }, this.readMain, this.readRefRow, this.readSub));
      this.banner = el('p', { class: 'novideo', hidden: true });
      root.append(this.tri, this.banner, this.scrub);

      this.video = el('video', { muted: true, playsinline: true, loop: true, preload: 'auto', 'aria-hidden': 'true' });
      this.video.muted = true;
      this.video.addEventListener('loadeddata', () => this.onVideoReady());
      this.video.addEventListener('seeked', () => this.onSeeked());
      this.video.addEventListener('timeupdate', () => { if (!('requestVideoFrameCallback' in this.video)) this.onVideoFrame(); });
      this.video.addEventListener('play', () => this.setPlaying(true));
      this.video.addEventListener('pause', () => this.setPlaying(false));
      this.video.addEventListener('error', () => this.onVideoError());

      this.plot.addEventListener('pointerdown', e => this.onPointer(e, true));
      this.plot.addEventListener('pointermove', e => this.onPointer(e, false));
      this.plot.addEventListener('pointerup', e => { this.dragging = false; try { this.plot.releasePointerCapture(e.pointerId); } catch (_) {} });
      this.plot.addEventListener('pointerleave', () => { if (!this.dragging) this.hideHover(); });
      this.plot.addEventListener('keydown', e => this.onKey(e));
      this.plot.addEventListener('blur', () => this.hideHover());

      const ro = new ResizeObserver(() => this.layout()); // the frames resize with the clip's aspect, not only with the page
      for (const k of ['in', 'gt', 'ag']) ro.observe(this.canvas[k].parentElement);
      new ResizeObserver(() => { if (this.run) { this.buildPlot(); this.updateHead(); } }).observe(this.plot);
      new IntersectionObserver(es => {
        this.visible = es[0].isIntersecting;
        if (!this.visible && this.playing) { this.video.pause(); this.wantPlay = this.eager; }
        else if (this.visible && this.wantPlay && this.videoReady && !this.userPaused) this.play();
        if (this.visible && this.run && !this.video.src && this.run.video) this.ensureVideo();
      }, { threshold: 0.3 }).observe(this.tri);
    }

    // ---- loading a run
    load(run, { play = false } = {}) {
      const first = !this.run;
      this.run = run;
      this.videoReady = false;
      this.userPaused = false;
      this.wantPlay = play && !reduceMotion;
      const v = run.video;
      this.frames = run.frames || (v && v.frames) || (run.curve ? run.curve.err.length : 1);
      this.fps = run.fps || (v && v.fps) || 30;
      this.frame = clamp(v ? v.posterFrame : 0, 0, this.frames - 1);
      this.view = Math.min(this.view, v ? v.views.length - 1 : 0);

      // per-frame values (null where the clip has no ground truth)
      this.errAt = new Array(this.frames).fill(null);
      this.refAt = new Array(this.frames).fill(null);
      if (run.curve) run.curve.err.forEach((e, i) => {
        const f = run.curve.idx ? run.curve.idx[i] : i;
        if (f < this.frames) { this.errAt[f] = e; if (run.curve.ref) this.refAt[f] = run.curve.ref[i]; }
      });
      this.worst = this.errAt.reduce((b, e, i) => (e != null && (b < 0 || e > this.errAt[b]) ? i : b), -1);
      this.worstBtn.hidden = this.worst < 0;

      // captions
      const kp = v && v.inputKind === 'keypoints';
      const setNote = (node, long, short) => node.replaceChildren(el('span', { class: 'n-long', text: long }), el('span', { class: 'n-short', text: short }));
      if (kp) setNote(this.note.in, 'ground-truth keypoints, no video', 'keypoints, no video');
      else if (run.inputOverlay) setNote(this.note.in, 'what the agent saw, plus the scorer\u2019s overlay: green truth, orange agent', 'agent\u2019s input, with the scorer\u2019s overlay');
      else setNote(this.note.in, 'what the agent saw', 'what the agent saw');
      setNote(this.note.gt, (run.gt ? run.gt + ', ' : '') + 'hidden from the agent', 'hidden');
      setNote(this.note.ag, agentLine(run), run.modelName || run.model || '');
      this.scale.hidden = !run.curve || !v;
      if (v) { // the input panel takes the clip's own aspect
        const r = v.rects.input, b = v.inputBox || [0, 0, 1, 1];
        this.tri.style.setProperty('--ain', clamp((r[2] * v.w * b[2]) / (r[3] * v.h * b[3]), 0.75, 2.2).toFixed(4));
      }

      // messages over panels (withheld footage)
      const withheld = !v;
      for (const k of ['in', 'gt', 'ag']) { this.msg[k].hidden = true; this.msg[k].textContent = ''; }
      this.tri.hidden = withheld;
      this.banner.hidden = !withheld;
      if (withheld) {
        this.banner.textContent = (run.withheldVideo ? 'Video withheld: the footage licence does not allow redistribution.' : 'No comparison video was recorded for this run.')
          + (run.curve ? ' The scores and the error curve are complete.' : '');
      } else if (v.inputRedacted) {
        this.msg.in.textContent = 'Input video withheld: its licence does not allow redistribution. The ground truth and the agent’s motion are shown.';
        this.msg.in.hidden = false;
      }
      this.playBtn.disabled = withheld;
      this.playBtn.style.visibility = withheld ? 'hidden' : '';

      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
      this.buildPlot();
      this.updateHead();
      this.updateViews();
      this.hideHover();

      if (!first) { this.root.classList.remove('swap'); void this.root.offsetWidth; this.root.classList.add('swap'); }
      const token = (this.token = {});
      poster(run).then(im => { if (this.token === token) { this.posterImg = im; if (!this.videoReady) this.draw(); } });
      if (v && (this.eager || this.visible)) this.ensureVideo();
      this.root.dispatchEvent(new CustomEvent('runchange', { detail: run }));
    }

    ensureVideo() {
      const v = this.run && this.run.video;
      if (!v || this.video.getAttribute('src')) return;
      this.triedFallback = false;
      this.video.src = v.src;
      this.video.load();
    }
    onVideoReady() {
      this.videoReady = true;
      this.awaitFirst = true; // the frame decoded at load is frame 0; ignore frames until the first seek lands
      this.seekQueued = false;
      this.video.currentTime = (this.frame + 0.5) / this.fps;
      if ('requestVideoFrameCallback' in this.video) {
        const tick = (now, meta) => {
          this.onVideoFrame(meta.mediaTime);
          this.vfc = this.video.requestVideoFrameCallback(tick);
        };
        if (this.vfc) this.video.cancelVideoFrameCallback(this.vfc);
        this.vfc = this.video.requestVideoFrameCallback(tick);
      }
      if (this.wantPlay && this.visible !== false) this.play();
    }
    onSeeked() {
      this.awaitFirst = false;
      this.onVideoFrame();
      if (this.seekQueued) { this.seekQueued = false; this.requestFrame(); } // scrubbing: go to the newest target
    }
    // Seeks are coalesced: while one is in flight the newest target waits, so every decoded frame is shown and a
    // slow decoder cannot fall further and further behind the pointer.
    requestFrame() {
      if (!this.videoReady) return;
      if (this.video.seeking) { this.seekQueued = true; return; }
      this.video.currentTime = (this.frame + 0.5) / this.fps;
    }
    onVideoFrame(t) {
      if (!this.videoReady || this.awaitFirst) return;
      const time = t == null ? this.video.currentTime : t;
      const scrubbing = this.dragging || this.seekQueued || this.video.seeking;
      if (!scrubbing) this.frame = clamp(Math.floor(time * this.fps + 1e-4), 0, this.frames - 1); // else the pointer leads
      this.draw();
      this.updateHead();
    }
    onVideoError() {
      const v = this.run && this.run.video;
      if (!v) return;
      if (v.fallback && !this.triedFallback) { // the scrub-friendly copy is not built: use the scorer's own video
        this.triedFallback = true;
        this.video.src = v.fallback;
        this.video.load();
        return;
      }
      this.videoReady = false;
      this.banner.textContent = 'The comparison video could not be loaded' + (this.posterImg ? '; a still frame is shown.' : '.') + ' The error curve is complete.';
      this.banner.hidden = false;
      this.playBtn.disabled = true;
    }

    // ---- drawing
    layout() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      for (const k of ['in', 'gt', 'ag']) {
        const c = this.canvas[k], r = c.parentElement.getBoundingClientRect();
        const w = Math.max(2, Math.round(r.width * dpr)), h = Math.max(2, Math.round(r.height * dpr));
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      }
      this.draw();
    }
    draw() {
      const v = this.run && this.run.video;
      if (!v) return;
      const src = this.videoReady && this.video.readyState >= 2 ? this.video : this.posterImg;
      if (!src) return;
      const sw = src.videoWidth || src.naturalWidth, sh = src.videoHeight || src.naturalHeight;
      if (!sw) return;
      const vi = Math.min(this.view, v.views.length - 1), view = v.views[vi];
      // input: contain inside the 4:3 frame
      {
        const c = this.canvas.in, g = c.getContext('2d');
        const [sx, sy, w, h] = srcRect(sw, sh, v.rects.input, v.inputBox);
        g.clearRect(0, 0, c.width, c.height);
        const s = Math.min(c.width / w, c.height / h), dw = w * s, dh = h * s;
        g.imageSmoothingQuality = 'high';
        g.drawImage(src, sx, sy, w, h, (c.width - dw) / 2, (c.height - dh) / 2, dw, dh);
      }
      for (const k of ['gt', 'ag']) {
        const c = this.canvas[k], g = c.getContext('2d');
        const [sx, sy, w, h] = srcRect(sw, sh, v.rects[k + (vi + 1)], view.crop);
        g.imageSmoothingQuality = 'high';
        g.drawImage(src, sx, sy, w, h, 0, 0, c.width, c.height);
        if (k === 'ag' && view.crop && view.bg) { // paint over the burned-in colour bar; the page draws its own scale
          const [cx, cy, cw, ch] = view.crop, [lx, ly, lw, lh] = LEGEND_ZONE;
          g.fillStyle = view.bg;
          g.fillRect(((lx - cx) / cw) * c.width, ((ly - cy) / ch) * c.height, (lw / cw) * c.width + 2, (lh / ch) * c.height);
        }
      }
    }

    // ---- transport
    play() {
      if (!this.run || !this.run.video) return;
      this.ensureVideo();
      this.wantPlay = true;
      if (!this.videoReady) return;
      for (const p of players) if (p !== this && p.playing) { p.userPaused = true; p.video.pause(); }
      const pr = this.video.play();
      if (pr && pr.catch) pr.catch(() => { this.wantPlay = false; });
    }
    toggle() {
      if (this.playing) { this.userPaused = true; this.wantPlay = false; this.video.pause(); }
      else { this.userPaused = false; this.play(); }
    }
    setPlaying(on) {
      this.playing = on;
      this.playBtn.dataset.on = on ? '1' : '0';
      this.playBtn.setAttribute('aria-label', on ? 'Pause' : 'Play');
    }
    seek(f, pause) {
      if (f == null || f < 0) return;
      this.frame = clamp(Math.round(f), 0, this.frames - 1);
      if (pause && this.playing) { this.userPaused = true; this.wantPlay = false; this.video.pause(); }
      this.updateHead();
      if (this.run.video) {
        this.ensureVideo();
        this.requestFrame();
      }
    }
    setView(i) {
      this.view = i;
      this.updateViews();
      this.draw();
    }
    updateViews() {
      const names = this.run.views || ['Input view', 'Side view'];
      const n = this.run.video ? this.run.video.views.length : 0;
      this.root.dispatchEvent(new CustomEvent('views', { detail: { names, count: n, active: Math.min(this.view, Math.max(n - 1, 0)) } }));
      if (n) { // a colour bar is baked into the footage unless draw() paints it out: then our scale must sit over it
        const view = this.run.video.views[Math.min(this.view, n - 1)];
        this.scale.classList.toggle('cover', !(view.crop && view.bg));
      }
    }

    // ---- the curve
    buildPlot() {
      const W = Math.max(160, this.plot.clientWidth), H = this.plot.clientHeight || 96;
      const m = { l: 30, r: 8, t: 8, b: 18 };
      this.geo = { W, H, m, pw: W - m.l - m.r, ph: H - m.t - m.b };
      const g = this.geo, n = this.frames;
      this.x = f => g.m.l + (n > 1 ? f / (n - 1) : 0) * g.pw;
      this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      this.svg.replaceChildren();
      const vals = this.errAt.concat(this.refAt).filter(v => v != null);
      const hasCurve = vals.length > 0;
      if (hasCurve) {
        const top = Math.max(...vals) * 1.06;
        const ymax = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 30, 40, 50, 60, 80, 100].find(s => s >= top) || Math.ceil(top / 50) * 50;
        this.y = v => g.m.t + g.ph - (Math.min(v, ymax) / ymax) * g.ph;
        for (const t of [0, ymax / 2, ymax]) {
          this.svg.append(sv('line', { class: 'grid', x1: g.m.l, x2: W - g.m.r, y1: this.y(t), y2: this.y(t) }));
          const lab = sv('text', { class: 'tick', x: g.m.l - 6, y: this.y(t) + 3.5, 'text-anchor': 'end' });
          lab.textContent = (Number.isInteger(t) ? t : t.toFixed(1)) + (t === ymax ? '%' : '');
          this.svg.append(lab);
        }
        const path = arr => {
          let d = '', pen = false;
          arr.forEach((v, f) => {
            if (v == null) { pen = false; return; }
            d += (pen ? 'L' : 'M') + this.x(f).toFixed(1) + ' ' + this.y(v).toFixed(1);
            pen = true;
          });
          return d;
        };
        if (this.refAt.some(v => v != null)) this.svg.append(sv('path', { class: 'l-ref', d: path(this.refAt), pathLength: 1 }));
        this.svg.append(sv('path', { class: 'l-err', d: path(this.errAt), pathLength: 1 }));
        if (this.worst >= 0) {
          const wx = this.x(this.worst), wy = this.y(this.errAt[this.worst]) - 7;
          this.svg.append(sv('path', { class: 'worst', d: `M${wx - 3.5} ${wy - 5}h7l-3.5 5z` }));
        }
      } else {
        this.y = () => g.m.t + g.ph / 2;
        this.svg.append(sv('line', { class: 'track', x1: g.m.l, x2: W - g.m.r, y1: this.y(0), y2: this.y(0) }));
        this.trackOn = sv('line', { class: 'track-on', x1: g.m.l, x2: g.m.l, y1: this.y(0), y2: this.y(0) });
        this.svg.append(this.trackOn);
      }
      // time axis
      const dur = n / this.fps;
      const step = [0.5, 1, 2, 5, 10, 20].find(s => dur / s <= 7) || 30;
      for (let t = 0; t <= dur + 1e-6; t += step) {
        const lab = sv('text', { class: 'tick', x: this.x(Math.min(t * this.fps, n - 1)), y: H - 3, 'text-anchor': t === 0 ? 'start' : 'middle' });
        lab.textContent = t + ' s';
        this.svg.append(lab);
      }
      this.hoverLine = sv('line', { class: 'hover', y1: g.m.t, y2: g.m.t + g.ph, visibility: 'hidden' });
      this.head = sv('line', { class: 'head', y1: g.m.t - 2, y2: g.m.t + g.ph });
      this.dot = sv('circle', { class: 'dot', r: 4.5 });
      this.svg.append(this.hoverLine, this.head, this.dot);
      this.hasCurve = hasCurve;
      this.plot.setAttribute('aria-valuemin', '1');
      this.plot.setAttribute('aria-valuemax', String(n));
    }
    updateHead() {
      if (!this.geo) return;
      const f = this.frame, x = this.x(f), e = this.errAt[f], r = this.refAt[f];
      this.head.setAttribute('x1', x); this.head.setAttribute('x2', x);
      if (this.hasCurve && e != null) { this.dot.setAttribute('cx', x); this.dot.setAttribute('cy', this.y(e)); this.dot.removeAttribute('visibility'); }
      else this.dot.setAttribute('visibility', 'hidden');
      if (!this.hasCurve && this.trackOn) this.trackOn.setAttribute('x2', x);
      this.readMain.hidden = !this.hasCurve;
      this.readVal.textContent = e != null ? pct(e) + ' %' : 'no GT';
      this.readRefRow.hidden = r == null;
      this.readRef.textContent = r != null ? `frozen pose ${pct(r)} %` : '';
      this.readFrame.textContent = `frame ${f + 1} / ${this.frames}`;
      this.plot.setAttribute('aria-valuenow', String(f + 1));
      this.plot.setAttribute('aria-valuetext', `Frame ${f + 1} of ${this.frames}` + (e != null ? `, agent error ${pct(e)} percent of body size` : '') + (r != null ? `, frozen pose ${pct(r)} percent` : ''));
    }
    frameAt(clientX) {
      const b = this.plot.getBoundingClientRect(), g = this.geo;
      const x = ((clientX - b.left) / b.width) * g.W;
      return clamp(Math.round(((x - g.m.l) / g.pw) * (this.frames - 1)), 0, this.frames - 1);
    }
    onPointer(e, down) {
      if (!this.run) return;
      const f = this.frameAt(e.clientX);
      if (down) {
        this.dragging = true;
        try { this.plot.setPointerCapture(e.pointerId); } catch (_) {}
        this.seek(f, true);
      } else if (this.dragging) this.seek(f, false);
      this.showHover(f);
    }
    showHover(f) {
      const x = this.x(f), g = this.geo, e = this.errAt[f], r = this.refAt[f];
      this.hoverLine.setAttribute('x1', x); this.hoverLine.setAttribute('x2', x); this.hoverLine.removeAttribute('visibility');
      const rows = [el('div', { class: 't-x', text: `${(f / this.fps).toFixed(2)} s · frame ${f + 1}` })];
      if (e != null) rows.push(el('div', { class: 't-row' }, el('i', { class: 'key key-line key-ag' }), el('b', { text: pct(e) + ' %' }), 'Agent'));
      if (r != null) rows.push(el('div', { class: 't-row' }, el('i', { class: 'key key-line key-ref' }), el('b', { text: pct(r) + ' %' }), 'Frozen pose'));
      this.tip.replaceChildren(...rows);
      this.tip.hidden = false;
      const px = (x / g.W) * this.plot.clientWidth;
      this.tip.style.left = clamp(px, 84, Math.max(84, this.plot.clientWidth - 84)) + 'px';
    }
    hideHover() {
      this.tip.hidden = true;
      if (this.hoverLine) this.hoverLine.setAttribute('visibility', 'hidden');
    }
    onKey(e) {
      const big = Math.round(this.fps);
      const map = { ArrowLeft: -1, ArrowRight: 1, ArrowDown: -1, ArrowUp: 1, PageDown: -big, PageUp: big };
      if (e.key in map) { e.preventDefault(); this.seek(this.frame + map[e.key] * (e.shiftKey ? 10 : 1), true); this.showHover(this.frame); }
      else if (e.key === 'Home') { e.preventDefault(); this.seek(0, true); }
      else if (e.key === 'End') { e.preventDefault(); this.seek(this.frames - 1, true); }
      else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); this.toggle(); }
    }
  }

  // View toggle wired to a player (labels change per run: "Input view / Side view", or trunk views).
  function viewToggle(host, player) {
    host.setAttribute('role', 'group');
    host.setAttribute('aria-label', 'Camera for the 3D panels');
    player.root.addEventListener('views', ev => {
      const { names, count, active } = ev.detail;
      host.replaceChildren(...names.map((n, i) => el('button', {
        type: 'button', text: n, 'aria-pressed': String(i === active), disabled: i >= count,
        title: i >= count ? 'This run has a single view' : (i === 1 ? 'A camera the agent never saw: depth errors show here' : 'The camera of the input video'),
        onclick: () => player.setView(i),
      })));
      host.hidden = count < 1;
    });
  }

  // ------------------------------------------------------------------------------------------------ hero
  let hero = null;
  const heroRoot = $('#hero-figure');
  if (heroRoot && D.featured.length) {
    hero = new Scrub(heroRoot, { eager: true });
    viewToggle($('#hero-views'), hero);
    const tabs = $('#hero-tabs');
    const list = D.featured.map(id => runs.get(id)).filter(Boolean);
    list.forEach((r, i) => tabs.append(el('button', {
      class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(i === 0), title: protocolPhrase(r),
      onclick: ev => {
        for (const b of tabs.children) b.setAttribute('aria-selected', String(b === ev.currentTarget));
        hero.load(r, { play: hero.playing || hero.wantPlay });
      },
    }, r.tab || r.label, isMain(r) ? null : el('span', { class: 'tp', text: 'earlier protocol' }))));
    const cap = $('#hero-clip');
    heroRoot.addEventListener('runchange', ev => {
      const r = ev.detail;
      if (cap) cap.textContent = `${r.label}: ${r.modelName}, ${r.effort} effort, ${protocolPhrase(r)}.`
        + (r.npve == null ? '' : ` Score ${score(r.skill)} of 100; nPVE ${pct(r.npve)} % against ${pct(r.refNpve)} % for a frozen pose.`);
    });
    if (!reduceMotion) { heroRoot.classList.add('opening'); setTimeout(() => heroRoot.classList.remove('opening'), 2600); }
    hero.load(list[0], { play: true });
  }

  // ------------------------------------------------------------------------------------------------ run explorer
  const exRoot = $('#ex-figure');
  let explorer = null, currentRun = null;
  function openRun(id, scroll = true) {
    const r = runs.get(id);
    if (!r || !explorer) return;
    currentRun = r;
    explorer.load(r);
    renderFacts(r);
    markCurrent(id);
    try { history.replaceState(null, '', '#run/' + encodeURI(id)); } catch (_) {}
    if (scroll) $('#runs').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  }
  window.AMB_open = openRun;
  function markCurrent(id) {
    const list = $('#ex-list');
    for (const b of list.querySelectorAll('.ex-run')) {
      const on = b.dataset.id === id;
      b.setAttribute('aria-current', String(on));
      if (on && list.scrollHeight > list.clientHeight) { // scroll the list itself, never the page
        const d = b.getBoundingClientRect().top - list.getBoundingClientRect().top;
        list.scrollTop += d - list.clientHeight / 2 + b.offsetHeight / 2;
      }
    }
  }

  function renderFacts(r) {
    const e = exps.get(r.exp), c = r.condition != null ? e.conditions[r.condition] : null, src = D.sources[r.source] || null;
    $('#ex-title').textContent = r.label;
    $('#ex-clip').textContent = r.clip || '';
    const row = (k, ...v) => [el('dt', { text: k }), el('dd', null, ...v)];
    const scores = el('dl', { class: 'dl' },
      ...row('Score', r.skill == null ? '\u2013' : `${score(r.skill)} of 100  (position ${score(r.skillPos)}, velocity ${score(r.skillVel)})`),
      ...row('nPVE', r.npve == null ? 'not scored on a mesh' : `${pct(r.npve)} %  (frozen pose ${pct(r.refNpve)} %)`),
      ...row('nMPJVE', r.nmpjve == null ? '\u2013' : `${pct(r.nmpjve)} %/s  (frozen pose ${pct(r.refNmpjve)} %/s)`),
      ...row('Agent', agentLine(r)),
      ...row('Protocol', isMain(r) ? 'main' : 'earlier: see the extras in the given list'),
      ...(r.gt ? row('Ground truth', r.gt) : []),
      ...(src ? row('Source', src.url ? el('a', { href: src.url, rel: 'noopener', text: src.name }) : src.name, ' \u00b7 ' + src.licence) : []));
    // one block: the withheld list is the protocol's and stands in the task figure, so only what was given is listed
    if (c && c.given.length) scores.append(...row('Given', c.given.join('; ')));
    $('#ex-facts').replaceChildren(el('div', null, scores));
  }

  if (exRoot) {
    explorer = new Scrub(exRoot);
    viewToggle($('#ex-views'), explorer);
    const list = $('#ex-list');
    list.append(el('p', { class: 'ex-key', text: 'Score, 0 to 100' }));
    const rank = e => (e.diagnostic ? 2 : e.protocol === 'web' ? 0 : 1); // main protocol first, diagnostics last
    for (const e of [...D.experiments].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))) {
      if (!e.runs.length) continue;
      const tag = e.diagnostic ? 'diagnostic' : (e.protocol === 'web' ? 'main protocol' : 'earlier protocol');
      const g = el('div', { class: 'ex-g' }, el('h3', null, el('span', { text: e.id }), e.short, el('em', { text: tag })));
      for (const id of e.runs) {
        const r = runs.get(id);
        g.append(el('button', { class: 'ex-run', type: 'button', 'data-id': id, onclick: () => openRun(id, false) },
          el('span', { text: r.label }), el('span', { class: 'v', title: 'Score, 0 to 100', text: score(r.skill) })));
      }
      list.append(g);
    }
    const m = decodeURI(location.hash).match(/^#run\/(.+)$/);
    const start = m && runs.has(m[1]) ? m[1] : (D.featured[0] || D.runs[0].id);
    currentRun = runs.get(start);
    explorer.load(currentRun);
    renderFacts(currentRun);
    markCurrent(start);
    if (m && runs.has(m[1])) requestAnimationFrame(() => $('#runs').scrollIntoView());
  }

  // ------------------------------------------------------------------------------------------------ results tables
  const AX = { p: Math.max(...D.runs.map(r => Math.max(r.npve || 0, r.refNpve || 0))) * 1.06, v: Math.max(...D.runs.map(r => Math.max(r.nmpjve || 0, r.refNmpjve || 0))) * 1.06 };
  function dumbbell(a, ref, max, unit) {
    const W = 132, H = 22, x = v => 4 + (v / max) * (W - 8);
    const s = sv('svg', { class: 'db', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Agent ${pct(a)} ${unit}, frozen pose ${pct(ref)} ${unit}` });
    s.append(sv('line', { class: 'ax', x1: 4, x2: W - 4, y1: H / 2, y2: H / 2 }));
    s.append(sv('line', { class: 'conn', x1: x(a), x2: x(ref), y1: H / 2, y2: H / 2 }));
    s.append(sv('line', { class: 'rf', x1: x(ref), x2: x(ref), y1: 4, y2: H - 4 }));
    s.append(sv('circle', { class: 'ag' + (a < ref ? '' : ' open'), cx: x(a), cy: H / 2, r: a < ref ? 5.5 : 4.5 }));
    const t = sv('title'); t.textContent = `Agent ${pct(a)} ${unit}, frozen pose ${pct(ref)} ${unit}`; s.append(t);
    return s;
  }
  function resultRow(r) {
    const nums = (a, ref, lab) => a == null
      ? [el('td', { class: 'n t-muted', colspan: '3', text: lab === 'nPVE' ? 'keypoint task, no mesh score' : '' })]
      : [el('td', { class: 'n a', 'data-l': lab, text: pct(a) }), el('td', { class: 'n r', 'data-l': 'frozen pose', text: pct(ref) }),
         el('td', { class: 'bar-cell', 'data-m': lab === 'nPVE' ? 'p' : 'v' }, dumbbell(a, ref, lab === 'nPVE' ? AX.p : AX.v, lab === 'nPVE' ? '%' : '%/s'))];
    return el('tr', null,
      el('th', { scope: 'row', class: 'clip' }, el('button', { class: 'runbtn', type: 'button', text: r.label, title: 'Open this run', onclick: () => openRun(r.id) }),
        r.repaired ? el('span', { class: 'flag', text: 'repaired', title: 'The scorer repaired this submission; see the run' }) : null),
      el('td', { class: 'agent', text: agentLine(r) }),
      el('td', { class: 'n sc' + (r.skill == null ? ' t-muted' : ' a'), 'data-l': 'score', text: score(r.skill),
        title: r.skill == null ? null : `position ${score(r.skillPos)}, velocity ${score(r.skillVel)}` }),
      ...nums(r.npve, r.refNpve, 'nPVE'), ...(r.npve == null ? [el('td', { colspan: '3' })] : nums(r.nmpjve, r.refNmpjve, 'nMPJVE')));
  }
  const groups = {
    main: D.runs.filter(r => r.protocol === 'web' && !exps.get(r.exp).diagnostic),
    earlier: D.runs.filter(r => r.protocol !== 'web' && !exps.get(r.exp).diagnostic),
  };
  { // one table, main-protocol runs first; a row's tooltip says which protocol it ran under
    const body = $('#res-all tbody');
    if (body) body.replaceChildren(...[...groups.main, ...groups.earlier].map(r => { const tr = resultRow(r); tr.title = protocolPhrase(r); return tr; }));
  }

  // ------------------------------------------------------------------------------------------------ task matrix
  const mx = $('#matrix');
  if (mx) {
    const bodies = ['robot', 'human', 'other'], videos = ['blank', 'env', 'real'];
    const pending = { 'human|blank': 'Synthetic clip in production', 'human|env': 'Synthetic clip in production', 'other|blank': 'Synthetic clip in production', 'other|env': 'Synthetic clip in production' };
    mx.append(el('div', { class: 'mx-h' }), ...videos.map(v => el('div', { class: 'mx-h', text: D.videoLabels[v] })));
    for (const b of bodies) {
      mx.append(el('div', { class: 'mx-r', text: D.bodyLabels[b] }));
      for (const v of videos) {
        const ids = D.matrix[b + '|' + v] || [];
        if (!ids.length) { mx.append(el('div', { class: 'mx-c none', 'data-col': D.videoLabels[v], text: pending[b + '|' + v] || 'No runs yet' })); continue; }
        const cell = el('div', { class: 'mx-c', 'data-col': D.videoLabels[v] });
        for (const id of ids) {
          const r = runs.get(id);
          const thumb = el('canvas', { width: 104, height: 78, 'aria-hidden': 'true' });
          poster(r).then(im => {
            if (!im || !r.video || r.video.inputRedacted) return;
            const [sx, sy, w, h] = srcRect(im.naturalWidth, im.naturalHeight, r.video.rects.input, r.video.inputBox);
            const s = Math.max(104 / w, 78 / h), dw = w * s, dh = h * s;
            thumb.getContext('2d').drawImage(im, sx, sy, w, h, (104 - dw) / 2, (78 - dh) / 2, dw, dh);
          });
          cell.append(el('button', { class: 'chip' + (isMain(r) ? '' : ' early'), type: 'button', title: `Open this run (${protocolPhrase(r)})`, onclick: () => openRun(id) }, thumb,
            el('span', { class: 'cl', text: r.label }),
            el('span', { class: 'cv' + (r.skill == null ? ' t-muted' : ''), title: 'Score, 0 to 100', text: score(r.skill) })));
        }
        mx.append(cell);
      }
    }
  }

  // ------------------------------------------------------------------------------------------------ tables that stack on phones
  for (const t of document.querySelectorAll('table.stack')) {
    const heads = [...t.querySelectorAll('thead th')].map(th => th.textContent.trim());
    for (const tr of t.querySelectorAll('tbody tr')) [...tr.children].forEach((c, i) => { if (i > 0) c.dataset.l = heads[i] || ''; });
  }

  // ------------------------------------------------------------------------------------------------ numbers in prose
  const stats = { runs: D.runs.length };
  for (const s of document.querySelectorAll('[data-stat]')) if (stats[s.dataset.stat] != null) s.textContent = stats[s.dataset.stat];
  for (const s of document.querySelectorAll('[data-run-val]')) {
    const [id, k] = s.dataset.runVal.split('|'), r = runs.get(id);
    if (r && r[k] != null) s.textContent = k === 'skill' ? score(r[k]) : pct(r[k]);
  }

  // ------------------------------------------------------------------------------------------------ overview figure (the task)
  const taskFig = $('#task-fig');
  if (taskFig && D.figure) { // drawn by bench/fig_task_flow.py from one run; a public build takes a run it may show
    const im = $('#task-fig-img');
    im.width = D.figure.w;
    im.height = D.figure.h;
    if (im.getAttribute('src') !== D.figure.src) im.src = D.figure.src;
    taskFig.hidden = false;
  }

  // ------------------------------------------------------------------------------------------------ small things
  for (const n of document.querySelectorAll('[data-internal]')) n.hidden = D.public;
  for (const n of document.querySelectorAll('[data-repo-only]')) n.hidden = D.public || D.standalone;
  // repository links live in the data only: a public build carries them once the repository is declared public
  for (const a of document.querySelectorAll('[data-repo-link]')) {
    if (D.repo) { a.href = D.repo; a.hidden = false; continue; }
    if (!a.classList.contains('btn')) continue; // text links stay hidden
    const s = el('span', { class: 'btn', role: 'link', 'aria-disabled': 'true', title: 'The code is not public yet' });
    s.append(...a.childNodes, ' (soon)'); // "Code (soon)", beside "Paper (soon)"
    a.replaceWith(s);
    const rb = $('.cta a[href="#runs"]');
    if (rb) rb.classList.replace('btn-line', 'btn-solid'); // the run browser becomes the main action
  }
  const copy = $('#copy-bib');
  if (copy) copy.addEventListener('click', async () => {
    const text = $('#bibtex').textContent;
    try { await navigator.clipboard.writeText(text); copy.lastChild.textContent = 'Copied'; }
    catch (_) { const r = document.createRange(); r.selectNodeContents($('#bibtex')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); copy.lastChild.textContent = 'Selected: press Ctrl+C'; }
    setTimeout(() => { copy.lastChild.textContent = 'Copy'; }, 2200);
  });
  // current section in the bar
  const links = [...document.querySelectorAll('.bar nav a[href^="#"]')];
  const byId = new Map(links.map(a => [a.getAttribute('href').slice(1), a]));
  const io = new IntersectionObserver(es => {
    for (const e of es) if (e.isIntersecting) for (const a of links) a.setAttribute('aria-current', String(a === byId.get(e.target.id)));
  }, { rootMargin: '-45% 0px -50% 0px' });
  for (const id of byId.keys()) { const t = document.getElementById(id); if (t) io.observe(t); }
})();
