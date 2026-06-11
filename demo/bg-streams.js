/* bg-streams.js — flowing ribbon lines background variant */
(function () {
  'use strict';

  var KEY = 'streams';
  var LABEL = 'Streams';

  /* ── helpers ──────────────────────────────────────────────────────────── */
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function gaussian(d, r) { return Math.exp(-(d * d) / (2 * r * r)); }

  /* ── variant ──────────────────────────────────────────────────────────── */
  var variant = {
    key: KEY,
    label: LABEL,

    /* internal state */
    _canvas: null,
    _ctx: null,
    _dpr: 1,
    _W: 0,       /* logical pixels */
    _H: 0,
    _lines: [],
    _raf: 0,
    _t: 0,
    _ptrX: -9999,
    _ptrY: -9999,
    _pulses: [],   /* { t0, speed, amp } */
    _theme: 'dark',
    _reduced: false,
    _hidden: false,

    /* bound listener refs for clean removal */
    _onResize: null,
    _onPointerMove: null,
    _onPointerDown: null,
    _onVisibility: null,

    /* ── init ─────────────────────────────────────────────────────────── */
    init: function (canvas, opts) {
      this.destroy();   /* idempotent: clean before re-init */

      this._canvas = canvas;
      this._theme  = (opts && opts.theme) || 'dark';
      this._reduced = (typeof matchMedia === 'function') &&
                      matchMedia('(prefers-reduced-motion: reduce)').matches;

      var ctx = canvas.getContext('2d');
      this._ctx = ctx;

      this._resize();
      this._buildLines();

      /* bind listeners */
      var self = this;
      this._onResize = function () { self._resize(); self._buildLines(); };
      this._onPointerMove = function (e) { self._ptrX = e.clientX; self._ptrY = e.clientY; };
      this._onPointerDown = function () {
        self._pulses.push({ t0: self._t, speed: 420, amp: 28 });
        if (self._pulses.length > 6) self._pulses.shift();
      };
      this._onVisibility = function () { self._hidden = document.hidden; };

      window.addEventListener('resize', this._onResize);
      window.addEventListener('pointermove', this._onPointerMove);
      window.addEventListener('pointerdown', this._onPointerDown);
      document.addEventListener('visibilitychange', this._onVisibility);

      this._t = 0;
      this._tick();
    },

    /* ── destroy ──────────────────────────────────────────────────────── */
    destroy: function () {
      if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
      if (this._onResize)       window.removeEventListener('resize', this._onResize);
      if (this._onPointerMove)  window.removeEventListener('pointermove', this._onPointerMove);
      if (this._onPointerDown)  window.removeEventListener('pointerdown', this._onPointerDown);
      if (this._onVisibility)   document.removeEventListener('visibilitychange', this._onVisibility);
      this._onResize = this._onPointerMove = this._onPointerDown = this._onVisibility = null;
      this._lines = []; this._pulses = [];
      this._canvas = null; this._ctx = null;
    },

    /* ── resize ───────────────────────────────────────────────────────── */
    _resize: function () {
      var canvas = this._canvas;
      if (!canvas) return;
      var dpr = window.devicePixelRatio || 1;
      this._dpr = dpr;
      var W = canvas.clientWidth  || window.innerWidth;
      var H = canvas.clientHeight || window.innerHeight;
      this._W = W; this._H = H;
      canvas.width  = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      if (this._ctx) this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    },

    /* ── build lines ──────────────────────────────────────────────────── */
    _buildLines: function () {
      var H = this._H;
      var reduced = this._reduced;

      /* line count scales with height, capped */
      var base = Math.round(clamp(H / 18, 25, 60));
      var count = reduced ? Math.floor(base * 0.55) : base;

      /* hue range: 185 (cyan) → 245 (indigo) */
      var lines = [];
      for (var i = 0; i < count; i++) {
        var frac = i / (count - 1);   /* 0…1, top→bottom */
        var baseY = H * 0.04 + H * 0.92 * frac;

        /* density gradient: top-left quadrant — reduce alpha */
        var topLeftFactor = clamp(1 - frac * 0.5, 0.4, 1);   /* dimmer near top */

        /* highlight: one in ~12 lines gets boosted alpha */
        var isHighlight = (i % 12 === 7);
        var alpha = isHighlight
          ? 0.28 + Math.random() * 0.07
          : (0.05 + Math.random() * 0.30) * topLeftFactor;

        /* very rare warm accent */
        var hue;
        if (i % 41 === 3) {
          hue = 322;   /* #f472b6 pink */
        } else {
          hue = Math.round(lerp(185, 245, frac + (Math.random() - 0.5) * 0.15));
        }

        /* 2–3 sine wave components */
        var numWaves = 2 + (Math.random() < 0.4 ? 1 : 0);
        var waves = [];
        for (var w = 0; w < numWaves; w++) {
          waves.push({
            amp:    8 + Math.random() * 22,
            freq:   0.0008 + Math.random() * 0.0018,   /* spatial, rad/px */
            speed:  0.25 + Math.random() * 0.55,        /* rad/s */
            phase:  Math.random() * Math.PI * 2
          });
        }

        /* flow-wave constants (precomputed — never allocate inside frame loop)
           wave: w = 0.55 + 0.45 * sin(waveK * x - waveOmega * t + wavePhase)
           speed v = waveOmega / waveK  →  90–150 px/s, halved when reduced */
        var flowSpeedBase = 90 + Math.random() * 60;   /* px/s */
        var flowSpeed = reduced ? flowSpeedBase * 0.5 : flowSpeedBase;
        var waveK     = (2 * Math.PI) / (180 + Math.random() * 120);  /* wavelength 180–300 px */
        var waveOmega = flowSpeed * waveK;              /* rad/s, derived from speed */
        var wavePhase = Math.random() * Math.PI * 2;

        lines.push({
          baseY: baseY,
          alpha: alpha,
          width: 0.6 + Math.random() * 1.2,
          hue: hue,
          waves: waves,
          isHighlight: isHighlight,
          /* flow-wave (brightness modulation, left→right) */
          waveK: waveK,
          waveOmega: waveOmega,
          wavePhase: wavePhase,
          /* pointer-displacement smoothing */
          dispY: 0,
          dispVel: 0
        });
      }
      this._lines = lines;
    },

    /* ── y for a line at position x, time t ──────────────────────────── */
    _lineY: function (line, x, t) {
      var y = line.baseY + line.dispY;
      var waves = line.waves;
      for (var w = 0; w < waves.length; w++) {
        var wv = waves[w];
        y += wv.amp * Math.sin(wv.freq * x + wv.speed * t + wv.phase);
      }
      /* pulse contributions */
      var pulses = this._pulses;
      for (var p = 0; p < pulses.length; p++) {
        var pu = pulses[p];
        var xFront = pu.speed * (t - pu.t0);
        var dist = x - xFront;
        /* gaussian envelope around the wave front */
        var env = gaussian(dist, 60);
        /* decaying amplitude */
        var age = t - pu.t0;
        var decay = Math.exp(-age * 0.7);
        y += pu.amp * env * decay * Math.sin(dist * 0.04);
      }
      return y;
    },

    /* ── main tick ────────────────────────────────────────────────────── */
    _tick: function () {
      var self = this;
      this._raf = requestAnimationFrame(function loop(ts) {
        if (!self._canvas) return;
        if (self._hidden) { self._raf = requestAnimationFrame(loop); return; }
        /* delta time, capped to avoid spiral-of-death on tab resume */
        var dt = self._lastTs ? Math.min((ts - self._lastTs) / 1000, 0.05) : 0.016;
        self._lastTs = ts;
        if (self._reduced) dt *= 0.5;
        self._t += dt;
        self._update(dt);
        self._draw();
        self._raf = requestAnimationFrame(loop);
      });
    },

    /* ── update physics ───────────────────────────────────────────────── */
    _update: function (dt) {
      var lines  = this._lines;
      var ptrX   = this._ptrX;
      var ptrY   = this._ptrY;
      var t      = this._t;
      var RADIUS = 150;
      var PUSH   = 60;   /* max vertical push in px */

      /* update line pointer displacement */
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        /* compute line y near pointer x */
        var nearY = this._lineY(line, ptrX, t) - line.dispY; /* without disp */
        var dy = nearY - ptrY;
        var push = gaussian(dy, RADIUS) * PUSH * Math.sign(-dy);
        /* spring toward push target */
        var target = (ptrX > -9000) ? push : 0;
        var spring = 6.0;
        var damping = 0.82;
        line.dispVel = line.dispVel * damping + (target - line.dispY) * spring * dt;
        line.dispY  += line.dispVel;
      }

      /* expire old pulses */
      var pulses = this._pulses;
      for (var p = pulses.length - 1; p >= 0; p--) {
        if (t - pulses[p].t0 > 3.5) pulses.splice(p, 1);
      }
    },

    /* ── draw ─────────────────────────────────────────────────────────── */
    _draw: function () {
      var ctx    = this._ctx;
      var W      = this._W;
      var H      = this._H;
      var lines  = this._lines;
      var t      = this._t;
      var dark   = this._theme === 'dark';

      /* background */
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = dark ? '#0b0f1a' : '#f6f8fa';
      ctx.fillRect(0, 0, W, H);

      /* ── draw ribbon lines with traveling brightness wave ──
         Each line is drawn as SEG_COUNT short strokes (~8 samples each).
         Alpha of each stroke is modulated by a sine wave that travels
         left→right: w = 0.55 + 0.45*sin(waveK*x_mid - waveOmega*t + wavePhase)
         This produces continuous soft pulses flowing like data through a pipe.
         ~40 lines × ~12 strokes = ~480 ctx.stroke() calls per frame max.    */
      var SAMPLES   = 96;    /* total sample points per line (divisible by SEG_COUNT) */
      var SEG_COUNT = 12;    /* strokes per line */
      var PTS_PER   = SAMPLES / SEG_COUNT;   /* 8 points per segment */
      var step = W / (SAMPLES - 1);
      ctx.globalCompositeOperation = 'source-over';

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var sat  = dark ? '70%' : '55%';
        var lum  = dark ? '65%' : '45%';
        var baseA = dark ? line.alpha : line.alpha * 0.75;
        var lw   = line.width;
        var hue  = line.hue;
        var wK   = line.waveK;
        var wOmega = line.waveOmega;
        var wPhase = line.wavePhase;

        for (var seg = 0; seg < SEG_COUNT; seg++) {
          var ptStart = seg * PTS_PER;
          var ptEnd   = ptStart + PTS_PER;   /* exclusive */

          /* x at segment midpoint for wave evaluation */
          var xMid = (ptStart + PTS_PER * 0.5) * step;

          /* brightness wave: 0.55…1.0 range */
          var wave = 0.55 + 0.45 * Math.sin(wK * xMid - wOmega * t + wPhase);
          var segA = baseA * wave;

          ctx.beginPath();
          for (var s = ptStart; s <= ptEnd; s++) {
            var px = s * step;
            var py = this._lineY(line, px, t);
            if (s === ptStart) { ctx.moveTo(px, py); } else { ctx.lineTo(px, py); }
          }
          ctx.strokeStyle = 'hsla(' + hue + ',' + sat + ',' + lum + ',' + segA + ')';
          ctx.lineWidth   = lw;
          ctx.stroke();
        }
      }

      /* ── soft top-left vignette to protect title area ── */
      var vGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, W * 0.45);
      vGrad.addColorStop(0,   dark ? 'rgba(11,15,26,0.45)' : 'rgba(246,248,250,0.45)');
      vGrad.addColorStop(0.6, dark ? 'rgba(11,15,26,0.12)' : 'rgba(246,248,250,0.12)');
      vGrad.addColorStop(1,   dark ? 'rgba(11,15,26,0)'    : 'rgba(246,248,250,0)');
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = vGrad;
      ctx.fillRect(0, 0, W * 0.5, H * 0.5);
    }
  };

  /* ── register ─────────────────────────────────────────────────────────── */
  window.BG_VARIANTS = window.BG_VARIANTS || {};
  window.BG_VARIANTS[KEY] = variant;

}());
