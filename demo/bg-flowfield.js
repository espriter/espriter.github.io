/* bg-flowfield.js — "물길" flow field background variant
 * Particles drift along a smooth 2-D value noise angle field.
 * No external dependencies; single IIFE, strict mode.
 */
(function () {
  'use strict';

  /* ── value noise helpers ─────────────────────────────────────── */

  // Deterministic hash (no Math.random for field)
  function hash2(ix, iy) {
    var n = ix * 127.1 + iy * 311.7;
    n = Math.sin(n) * 43758.5453123;
    return n - Math.floor(n);
  }

  function smoothstep(t) {
    return t * t * (3 - 2 * t);
  }

  // 3-D value noise: (x, y, t) → [0, 1]
  function valueNoise(x, y, t) {
    var ix = Math.floor(x), iy = Math.floor(y), it = Math.floor(t);
    var fx = x - ix, fy = y - iy, ft = t - it;
    var ux = smoothstep(fx), uy = smoothstep(fy), ut = smoothstep(ft);

    function h(a, b, c) {
      return hash2(a * 7919 + b * 6271 + c * 4001,
                   a * 3491 + b * 8221 + c * 5003);
    }

    // trilinear interpolation
    var n000 = h(ix,   iy,   it);
    var n100 = h(ix+1, iy,   it);
    var n010 = h(ix,   iy+1, it);
    var n110 = h(ix+1, iy+1, it);
    var n001 = h(ix,   iy,   it+1);
    var n101 = h(ix+1, iy,   it+1);
    var n011 = h(ix,   iy+1, it+1);
    var n111 = h(ix+1, iy+1, it+1);

    var x0 = n000 + ux*(n100-n000);
    var x1 = n010 + ux*(n110-n010);
    var x2 = n001 + ux*(n101-n001);
    var x3 = n011 + ux*(n111-n011);

    var y0 = x0 + uy*(x1-x0);
    var y1 = x2 + uy*(x3-x2);

    return y0 + ut*(y1-y0);
  }

  // Sample angle field at world-space position.
  // Base direction is east (0 rad); noise controls meandering ±0.8 rad.
  function fieldAngle(wx, wy, t, scale) {
    var v = valueNoise(wx * scale, wy * scale, t * 0.07);
    // Two octaves for richer variation
    var v2 = valueNoise(wx * scale * 2.1 + 5.3, wy * scale * 2.1 + 8.7, t * 0.07 * 2.1);
    // Combined noise in [0,1] → meander offset in [-0.8, +0.8] rad
    var combined = (v + v2 * 0.4) / 1.4;   // normalise to ≈[0,1]
    var meander  = (combined * 2 - 1) * 0.8; // map to [-0.8, 0.8]
    return meander; // base direction 0 (east) + meander
  }

  /* ── Particle ────────────────────────────────────────────────── */

  function Particle(cw, ch, reduced) {
    this.cw = cw;
    this.ch = ch;
    this.reduced = reduced;
    this.reset(true);
  }

  Particle.prototype.reset = function (randomPos) {
    var cw = this.cw, ch = this.ch;
    if (randomPos) {
      // Initial fill: scatter across canvas so it doesn't look empty at start
      this.x = Math.random() * (cw + 20) - 10;
      this.y = Math.random() * ch;
    } else {
      // Unidirectional respawn: always enter from the left edge
      this.x = -10;
      this.y = Math.random() * ch;
    }
    var baseSpeed = this.reduced ? 0.6 : 1.2;
    this.speed = baseSpeed * (0.5 + Math.random() * 0.9);
    this.vx = 0;
    this.vy = 0;
    this.impulse = 0; // outward impulse magnitude (decays)
    this.impulseX = 0;
    this.impulseY = 0;
    // hue parameter [0,1] used for color mapping
    this.hueT = Math.random();
  };

  Particle.prototype.update = function (t, noiseScale, ptr, ptrActive) {
    var cw = this.cw, ch = this.ch;

    // Base field angle
    var angle = fieldAngle(this.x, this.y, t, noiseScale);

    // Pointer vortex influence (radius and strength reduced so the
    // eastward current dominates outside the immediate cursor area)
    if (ptrActive) {
      var dx = this.x - ptr.x;
      var dy = this.y - ptr.y;
      var dist2 = dx*dx + dy*dy;
      var R = 130;
      if (dist2 < R*R && dist2 > 0.01) {
        var dist = Math.sqrt(dist2);
        var falloff = 1 - dist/R;
        falloff = falloff * falloff; // quadratic
        // Tangential angle (perpendicular to radius, CCW)
        var tangentAngle = Math.atan2(dx, -dy); // swirl direction
        // Blend field angle toward tangent (max 55% to keep eastward bias)
        var blend = falloff * 0.55;
        angle = angle * (1 - blend) + tangentAngle * blend;
      }
    }

    var targetVx = Math.cos(angle) * this.speed;
    var targetVy = Math.sin(angle) * this.speed;

    // Smooth velocity toward field direction
    var lag = 0.12;
    this.vx += (targetVx - this.vx) * lag;
    this.vy += (targetVy - this.vy) * lag;

    // Apply impulse
    if (this.impulse > 0.01) {
      this.x += this.impulseX * this.impulse;
      this.y += this.impulseY * this.impulse;
      this.impulse *= 0.88;
    } else {
      this.impulse = 0;
    }

    this.x += this.vx;
    this.y += this.vy;

    // Slowly shift hue param along x
    this.hueT = (this.hueT + 0.0003) % 1;

    // Respawn off the left edge when a particle leaves the canvas
    var M = 8;
    if (this.x > cw + M || this.y < -M || this.y > ch + M) {
      // exited right edge or top/bottom → re-enter from left
      this.reset(false);
    } else if (this.x < -M) {
      // travelled backward past left edge (only possible under heavy vortex)
      this.reset(false);
    }
  };

  /* ── Color helpers ───────────────────────────────────────────── */

  // Map t∈[0,1] across cyan→sky→indigo (dark) or sky→indigo→slate (light)
  function particleColor(t, theme, alpha) {
    var r, g, b;
    if (theme === 'dark') {
      // cyan #22d3ee → sky #38bdf8 → indigo #818cf8, rare pink
      if (t < 0.5) {
        var u = t * 2;
        r = Math.round(0x22 + u*(0x38-0x22));
        g = Math.round(0xd3 + u*(0xbd-0xd3));
        b = Math.round(0xee + u*(0xf8-0xee));
      } else {
        var u = (t - 0.5) * 2;
        r = Math.round(0x38 + u*(0x81-0x38));
        g = Math.round(0xbd + u*(0x8c-0xbd));
        b = Math.round(0xf8 + u*(0xf8-0xf8));
      }
    } else {
      // light: sky #0ea5e9 → indigo #6366f1 → slate #94a3b8
      if (t < 0.5) {
        var u = t * 2;
        r = Math.round(0x0e + u*(0x63-0x0e));
        g = Math.round(0xa5 + u*(0x66-0xa5));
        b = Math.round(0xe9 + u*(0xf1-0xe9));
      } else {
        var u = (t - 0.5) * 2;
        r = Math.round(0x63 + u*(0x94-0x63));
        g = Math.round(0x66 + u*(0xa3-0x66));
        b = Math.round(0xf1 + u*(0xb8-0xf1));
      }
    }
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha.toFixed(3) + ')';
  }

  /* ── Variant registration ────────────────────────────────────── */

  window.BG_VARIANTS = window.BG_VARIANTS || {};

  window.BG_VARIANTS['flow'] = {
    key: 'flow',
    label: 'Flow Field',

    // Internal state — all cleared in destroy()
    _raf: null,
    _canvas: null,
    _ctx: null,
    _particles: null,
    _t: 0,
    _ptr: { x: -9999, y: -9999 },
    _ptrActive: false,
    _opts: null,
    _dpr: 1,
    _noiseScale: 0,
    _reduced: false,
    _hidden: false,

    // Event handler references (bound once, removed in destroy)
    _onResize: null,
    _onPointerMove: null,
    _onPointerDown: null,
    _onVisibility: null,

    init: function (canvas, opts) {
      // Always clean up before re-initialising
      this.destroy();

      var self = this;
      this._canvas = canvas;
      this._opts = opts || {};
      this._t = 0;

      var mq = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
      this._reduced = mq && mq.matches;

      var ctx = canvas.getContext('2d');
      this._ctx = ctx;

      // DPR-aware sizing
      function resize() {
        var dpr = window.devicePixelRatio || 1;
        self._dpr = dpr;
        var w = canvas.clientWidth  || window.innerWidth;
        var h = canvas.clientHeight || window.innerHeight;
        canvas.width  = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        // Noise scale: ~one cell per 200 CSS px
        self._noiseScale = 1 / 200;

        // Rebuild particles on resize
        self._buildParticles(w, h);
      }
      resize();

      // Pointer move — track in CSS px
      function onPointerMove(e) {
        var rect = canvas.getBoundingClientRect();
        self._ptr.x = e.clientX - rect.left;
        self._ptr.y = e.clientY - rect.top;
        self._ptrActive = true;
      }

      // Pointer down — radial impulse
      function onPointerDown(e) {
        var rect = canvas.getBoundingClientRect();
        var px = e.clientX - rect.left;
        var py = e.clientY - rect.top;
        var R = 180;
        var ps = self._particles;
        for (var i = 0; i < ps.length; i++) {
          var p = ps[i];
          var dx = p.x - px, dy = p.y - py;
          var dist2 = dx*dx + dy*dy;
          if (dist2 < R*R && dist2 > 0.01) {
            var dist = Math.sqrt(dist2);
            var strength = (1 - dist/R);
            p.impulse = strength * (self._reduced ? 4 : 8);
            p.impulseX = dx / dist;
            p.impulseY = dy / dist;
          }
        }
      }

      function onVisibility() {
        self._hidden = document.hidden;
        if (!self._hidden && !self._raf) {
          self._loop();
        }
      }

      // Release the vortex when the cursor leaves the page
      function onPointerLeave() {
        self._ptrActive = false;
      }

      this._onResize       = resize;
      this._onPointerMove  = onPointerMove;
      this._onPointerDown  = onPointerDown;
      this._onVisibility   = onVisibility;
      this._onPointerLeave = onPointerLeave;

      window.addEventListener('resize',       this._onResize);
      window.addEventListener('pointermove',  this._onPointerMove);
      window.addEventListener('pointerdown',  this._onPointerDown);
      document.addEventListener('visibilitychange', this._onVisibility);
      document.documentElement.addEventListener('mouseleave', this._onPointerLeave);
      window.addEventListener('blur', this._onPointerLeave);

      this._loop();
    },

    _buildParticles: function (cssW, cssH) {
      var area = cssW * cssH;
      // ~1 particle per 300 px², clamped [1200, 2500]
      var count = Math.min(2500, Math.max(1200, Math.round(area / 300)));
      if (this._reduced) count = Math.round(count * 0.5);

      var ps = [];
      for (var i = 0; i < count; i++) {
        ps.push(new Particle(cssW, cssH, this._reduced));
      }
      // Update particle canvas dimensions if already exist
      this._particles = ps;
    },

    _loop: function () {
      if (this._hidden) { this._raf = null; return; }

      var self = this;
      this._raf = requestAnimationFrame(function () { self._loop(); });
      this._draw();
    },

    _draw: function () {
      var ctx    = this._ctx;
      var canvas = this._canvas;
      var opts   = this._opts;
      var theme  = (opts && opts.theme) || 'dark';
      var ps     = this._particles;
      if (!ctx || !ps) return;

      var cssW = canvas.clientWidth  || window.innerWidth;
      var cssH = canvas.clientHeight || window.innerHeight;

      var timeStep = this._reduced ? 0.3 : 0.6;
      this._t += timeStep;
      var t = this._t;

      // Translucent fade — creates silky trails
      var bgColor   = (theme === 'dark') ? '11,15,26' : '246,248,250';
      var fadeAlpha = (theme === 'dark') ? 0.055 : 0.07;
      ctx.fillStyle = 'rgba(' + bgColor + ',' + fadeAlpha + ')';
      ctx.fillRect(0, 0, cssW, cssH);

      // Update & draw particles
      var noiseScale = this._noiseScale;
      var ptr        = this._ptr;
      var ptrActive  = this._ptrActive;

      for (var i = 0; i < ps.length; i++) {
        var p = ps[i];

        // Keep particle aware of current canvas dimensions
        p.cw = cssW;
        p.ch = cssH;

        p.update(t, noiseScale, ptr, ptrActive);

        // Compute color — hueT modulated by x position for spatial variation
        var hue    = (p.hueT * 0.6 + (p.x / cssW) * 0.4) % 1;
        var speed  = Math.sqrt(p.vx*p.vx + p.vy*p.vy);
        var maxSpd = p.speed * 1.4;
        var alpha  = (theme === 'dark')
          ? 0.25 + (speed / maxSpd) * 0.55
          : 0.18 + (speed / maxSpd) * 0.40;

        // Top-left quadrant: reduce opacity to keep title readable
        var tlFactor = 1;
        if (p.x < cssW * 0.45 && p.y < cssH * 0.42) {
          tlFactor = 0.35;
        }
        alpha *= tlFactor;

        ctx.strokeStyle = particleColor(hue, theme, alpha);
        ctx.lineWidth   = (theme === 'dark') ? 0.9 : 0.8;
        ctx.beginPath();
        ctx.moveTo(p.x - p.vx * 2, p.y - p.vy * 2);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }

      // Single glow pass on dark theme (full-canvas blur is applied once via
      // a separate alpha layer rather than per-element shadowBlur)
      if (theme === 'dark') {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = 'rgba(34,211,238,0.018)';
        ctx.fillRect(0, 0, cssW, cssH);
        ctx.restore();
      }
    },

    destroy: function () {
      if (this._raf) {
        cancelAnimationFrame(this._raf);
        this._raf = null;
      }
      if (this._onResize) {
        window.removeEventListener('resize',      this._onResize);
        this._onResize = null;
      }
      if (this._onPointerMove) {
        window.removeEventListener('pointermove', this._onPointerMove);
        this._onPointerMove = null;
      }
      if (this._onPointerDown) {
        window.removeEventListener('pointerdown', this._onPointerDown);
        this._onPointerDown = null;
      }
      if (this._onVisibility) {
        document.removeEventListener('visibilitychange', this._onVisibility);
        this._onVisibility = null;
      }
      if (this._onPointerLeave) {
        document.documentElement.removeEventListener('mouseleave', this._onPointerLeave);
        window.removeEventListener('blur', this._onPointerLeave);
        this._onPointerLeave = null;
      }
      this._canvas    = null;
      this._ctx       = null;
      this._particles = null;
      this._ptr       = { x: -9999, y: -9999 };
      this._ptrActive = false;
      this._opts      = null;
      this._hidden    = false;
    }
  };

}());
