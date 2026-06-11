/* bg-pipeline.js — Data Pipeline DAG background variant */
(function () {
  'use strict';

  var KEY = 'pipeline';

  // ── helpers ──────────────────────────────────────────────────────────────

  function rng(seed) {
    // mulberry32
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeInOut(t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // cubic bezier point at parameter t
  function bezierPt(p0, p1, p2, p3, t) {
    var mt = 1 - t;
    return {
      x: mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x,
      y: mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y
    };
  }

  // build arc-length LUT (~40 segments) for constant-speed travel
  function buildLUT(p0, p1, p2, p3, steps) {
    steps = steps || 40;
    var pts = [];
    var dist = [0];
    var prev = bezierPt(p0, p1, p2, p3, 0);
    pts.push(prev);
    for (var i = 1; i <= steps; i++) {
      var cur = bezierPt(p0, p1, p2, p3, i / steps);
      var dx = cur.x - prev.x, dy = cur.y - prev.y;
      dist.push(dist[dist.length - 1] + Math.sqrt(dx * dx + dy * dy));
      pts.push(cur);
      prev = cur;
    }
    return { pts: pts, dist: dist, len: dist[dist.length - 1] };
  }

  // sample position at arc-length s along LUT
  function sampleLUT(lut, s) {
    var d = lut.dist, p = lut.pts;
    var lo = 0, hi = d.length - 1;
    s = clamp(s, 0, d[hi]);
    while (lo < hi - 1) {
      var mid = (lo + hi) >> 1;
      if (d[mid] < s) lo = mid; else hi = mid;
    }
    var t = (s - d[lo]) / (d[hi] - d[lo] || 1);
    return {
      x: lerp(p[lo].x, p[hi].x, t),
      y: lerp(p[lo].y, p[hi].y, t)
    };
  }

  // distance from point to bezier (approximate via LUT)
  function distToLUT(lut, px, py) {
    var best = Infinity;
    for (var i = 0; i < lut.pts.length; i++) {
      var dx = lut.pts[i].x - px, dy = lut.pts[i].y - py;
      var d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }

  // ── DAG generation ───────────────────────────────────────────────────────

  function buildDAG(W, H, rand) {
    var numLayers = 5 + Math.floor(rand() * 3); // 5–7 (first/last sit off-screen)
    var layers = [];
    var i, j, k;

    for (i = 0; i < numLayers; i++) {
      var count = 3 + Math.floor(rand() * 4); // 3–6 nodes
      layers.push(count);
    }

    // push sources/sinks past the viewport so pipes appear to flow
    // in from beyond the left edge and out beyond the right edge
    var xMargin = -W * 0.08;
    var xEnd = W * 1.08;
    var yMarginTop = H * 0.12;
    var yMarginBot = H * 0.88;

    var nodes = [];
    var layerNodes = []; // layerNodes[i] = array of node indices in layer i

    for (i = 0; i < numLayers; i++) {
      layerNodes.push([]);
      var count = layers[i];
      var xFrac = i / (numLayers - 1);
      var x = xMargin + xFrac * (xEnd - xMargin);

      for (j = 0; j < count; j++) {
        var yFrac = count === 1 ? 0.5 : j / (count - 1);
        var y = yMarginTop + yFrac * (yMarginBot - yMarginTop);
        // add jitter
        x += (rand() - 0.5) * W * 0.015;
        y += (rand() - 0.5) * H * 0.04;
        var idx = nodes.length;
        nodes.push({
          id: idx, layer: i,
          bx: x, by: y, // base position (layout target)
          x: x, y: y,   // current drawn position (lerped during morph + breathing)
          // morph
          morphTargetX: x, morphTargetY: y,
          morphSrcX: x, morphSrcY: y,
          morphT: 1.0, // 1 = morph complete
          // breathing
          phaseX: rand() * Math.PI * 2,
          phaseY: rand() * Math.PI * 2,
          speedX: 0.18 + rand() * 0.12,
          speedY: 0.22 + rand() * 0.12,
          pulse: 0, // 0–1 pulse animation
          label: layerLabel(i, numLayers),
          // lineage highlight
          h: 0,       // current highlight [0,1]
          hTarget: 0, // target highlight
          // nudge (click spring)
          nudgeX: 0, nudgeY: 0,
          nudgeVX: 0, nudgeVY: 0
        });
        layerNodes[i].push(idx);
      }
    }

    // build edges: each node connects to 1–3 nodes in next layer
    var edges = [];
    for (i = 0; i < numLayers - 1; i++) {
      var fromLayer = layerNodes[i];
      var toLayer = layerNodes[i + 1];
      for (j = 0; j < fromLayer.length; j++) {
        var fanout = 1 + Math.floor(rand() * 3);
        fanout = Math.min(fanout, toLayer.length);
        // pick fanout unique targets
        var targets = toLayer.slice().sort(function () { return rand() - 0.5; }).slice(0, fanout);
        for (k = 0; k < targets.length; k++) {
          edges.push({
            from: fromLayer[j],
            to: targets[k],
            lut: null, // computed after node positions known
            highlight: 0, // 0–1 proximity highlight (legacy, kept for compat)
            h: 0,       // lineage highlight [0,1]
            hTarget: 0,
            // shimmer: faint traveling brightness pulse
            shimmerPhase: rand() * 1000, // offset in px
            shimmerSpeed: 50 + rand() * 30 // px/s
          });
        }
      }
    }

    // ── build adjacency for lineage BFS ──
    var adj = buildAdjacency(nodes, edges);

    return { nodes: nodes, edges: edges, layerNodes: layerNodes, adj: adj };
  }

  // Build forward (children) + backward (parents) adjacency lists
  function buildAdjacency(nodes, edges) {
    var n = nodes.length;
    var children = [];  // children[i] = [nodeIdx, ...]
    var parents = [];   // parents[i]  = [nodeIdx, ...]
    var edgesFrom = []; // edgesFrom[i] = [edgeIdx, ...]  (edges where from===i)
    var edgesTo = [];   // edgesTo[i]   = [edgeIdx, ...]  (edges where to===i)
    var i;
    for (i = 0; i < n; i++) { children.push([]); parents.push([]); edgesFrom.push([]); edgesTo.push([]); }
    for (i = 0; i < edges.length; i++) {
      var e = edges[i];
      children[e.from].push(e.to);
      parents[e.to].push(e.from);
      edgesFrom[e.from].push(i);
      edgesTo[e.to].push(i);
    }
    return { children: children, parents: parents, edgesFrom: edgesFrom, edgesTo: edgesTo };
  }

  // BFS lineage: returns {nodeSet, edgeSet} of all upstream + downstream of seedNodes
  function computeLineage(seedNodes, dag) {
    var adj = dag.adj;
    var nodeSet = {};
    var edgeSet = {};
    var queue, qi, cur, nbrs, i, edgeIdx;

    // upstream (BFS via parents)
    queue = seedNodes.slice();
    for (qi = 0; qi < queue.length; qi++) nodeSet[queue[qi]] = true;
    qi = 0;
    while (qi < queue.length) {
      cur = queue[qi++];
      nbrs = adj.parents[cur];
      for (i = 0; i < nbrs.length; i++) {
        if (!nodeSet[nbrs[i]]) { nodeSet[nbrs[i]] = true; queue.push(nbrs[i]); }
      }
      // edges into cur
      var edgesIn = adj.edgesTo[cur];
      for (i = 0; i < edgesIn.length; i++) edgeSet[edgesIn[i]] = true;
    }

    // downstream (BFS via children)
    queue = seedNodes.slice();
    qi = 0;
    while (qi < queue.length) {
      cur = queue[qi++];
      nbrs = adj.children[cur];
      for (i = 0; i < nbrs.length; i++) {
        if (!nodeSet[nbrs[i]]) { nodeSet[nbrs[i]] = true; queue.push(nbrs[i]); }
      }
      // edges out of cur
      var edgesOut = adj.edgesFrom[cur];
      for (i = 0; i < edgesOut.length; i++) edgeSet[edgesOut[i]] = true;
    }

    return { nodeSet: nodeSet, edgeSet: edgeSet };
  }

  function layerLabel(i, total) {
    var src = ['kafka', 'pg', 's3', 'api', 'db'];
    var tx = ['flink', 'spark', 'dbt', 'beam'];
    var sk = ['iceberg', 'warehouse', 'clickhouse', 'bi'];
    if (i === 0) return src[i % src.length];
    if (i === total - 1) return sk[i % sk.length];
    return tx[i % tx.length];
  }

  function recomputeLUTs(dag) {
    var nodes = dag.nodes, edges = dag.edges;
    for (var i = 0; i < edges.length; i++) {
      var e = edges[i];
      var n0 = nodes[e.from], n1 = nodes[e.to];
      var dx = (n1.x - n0.x) * 0.45;
      var cp0 = { x: n0.x + dx, y: n0.y };
      var cp1 = { x: n1.x - dx, y: n1.y };
      e.p0 = { x: n0.x, y: n0.y };
      e.p1 = cp0;
      e.p2 = cp1;
      e.p3 = { x: n1.x, y: n1.y };
      e.lut = buildLUT(e.p0, e.p1, e.p2, e.p3, 40);
    }
  }

  // ── packet management ────────────────────────────────────────────────────

  function createPacket(edge, dag, speed) {
    return {
      edge: edge,
      s: 0, // arc-length progress
      speed: speed || (60 + Math.random() * 80), // px per second
      alpha: 0,
      done: false
    };
  }

  function spawnFromNode(nodeIdx, dag, packets, maxPackets, speed) {
    var edges = dag.edges;
    var spawned = 0;
    for (var i = 0; i < edges.length; i++) {
      if (edges[i].from === nodeIdx && packets.length < maxPackets) {
        packets.push(createPacket(edges[i], dag, speed));
        spawned++;
      }
    }
    return spawned;
  }

  // ── main module ──────────────────────────────────────────────────────────

  window.BG_VARIANTS = window.BG_VARIANTS || {};
  window.BG_VARIANTS[KEY] = {
    key: KEY,
    label: 'Pipeline',

    _raf: null,
    _canvas: null,
    _ctx: null,
    _dag: null,
    _packets: null,
    _dpr: 1,
    _W: 0,
    _H: 0,
    _theme: 'dark',
    _mouse: { x: -9999, y: -9999 },
    _lastTime: 0,
    _idleTimer: 0,
    _idleInterval: 3500, // ms between idle spawns
    _reducedMotion: false,
    _hidden: false,
    _resizeHandler: null,
    _pointerMoveHandler: null,
    _pointerDownHandler: null,
    _visHandler: null,

    // parallax
    _parallaxX: 0,
    _parallaxY: 0,

    // lineage / focus
    _focusScalar: 0,      // global "is something hovered" [0,1], eased
    _focusTarget: 0,

    // click effects
    _ripples: [],         // [{x,y,t,maxR}]
    _pendingPackets: [],  // [{nodeIdx, delay, speed, remaining}]
    _pendingTimer: 0,

    // morph
    _morphTimer: 0,
    _morphInterval: 30,   // seconds base
    _morphVariance: 5,    // ±seconds
    _morphNextInterval: 30,
    _morphing: false,

    init: function (canvas, opts) {
      this.destroy();

      this._canvas = canvas;
      this._theme = (opts && opts.theme) || 'dark';
      this._reducedMotion = typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      this._packets = [];
      this._lastTime = 0;
      this._idleTimer = 0;
      this._parallaxX = 0;
      this._parallaxY = 0;
      this._focusScalar = 0;
      this._focusTarget = 0;
      this._ripples = [];
      this._pendingPackets = [];
      this._pendingTimer = 0;
      this._morphTimer = 0;
      this._morphing = false;
      this._morphNextInterval = this._morphInterval + (Math.random() * 2 - 1) * this._morphVariance;

      var self = this;
      this._ctx = canvas.getContext('2d');

      this._resizeHandler = function () { self._resize(); };
      this._pointerMoveHandler = function (e) {
        var r = self._canvas.getBoundingClientRect();
        self._mouse.x = (e.clientX - r.left) * self._dpr;
        self._mouse.y = (e.clientY - r.top) * self._dpr;
      };
      this._pointerDownHandler = function (e) {
        var r = self._canvas.getBoundingClientRect();
        var mx = (e.clientX - r.left) * self._dpr;
        var my = (e.clientY - r.top) * self._dpr;
        self._handleClick(mx, my);
      };
      this._visHandler = function () {
        self._hidden = document.hidden;
        if (!document.hidden) {
          self._lastTime = 0;
          self._tick(0);
        }
      };

      window.addEventListener('resize', this._resizeHandler, { passive: true });
      window.addEventListener('pointermove', this._pointerMoveHandler, { passive: true });
      window.addEventListener('pointerdown', this._pointerDownHandler, { passive: true });
      document.addEventListener('visibilitychange', this._visHandler);

      this._resize();
      this._raf = requestAnimationFrame(function (t) { self._tick(t); });
    },

    destroy: function () {
      if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
      if (this._resizeHandler) {
        window.removeEventListener('resize', this._resizeHandler);
        window.removeEventListener('pointermove', this._pointerMoveHandler);
        window.removeEventListener('pointerdown', this._pointerDownHandler);
        document.removeEventListener('visibilitychange', this._visHandler);
        this._resizeHandler = null;
        this._pointerMoveHandler = null;
        this._pointerDownHandler = null;
        this._visHandler = null;
      }
      this._canvas = null;
      this._ctx = null;
      this._dag = null;
      this._packets = null;
    },

    _resize: function () {
      var canvas = this._canvas;
      if (!canvas) return;
      var dpr = window.devicePixelRatio || 1;
      this._dpr = dpr;
      var W = canvas.offsetWidth;
      var H = canvas.offsetHeight;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      this._W = W * dpr;
      this._H = H * dpr;

      // rebuild DAG
      var seed = (Math.round(W) * 1000 + Math.round(H) + Date.now()) | 0;
      var rand = rng(seed);
      this._dag = buildDAG(this._W, this._H, rand);
      recomputeLUTs(this._dag);

      // seed initial packets
      this._packets = [];
      this._seedInitialPackets();
    },

    _seedInitialPackets: function () {
      if (!this._dag) return;
      var max = this._maxPackets();
      var dag = this._dag;
      // start a few packets on random edges
      var count = Math.floor(max * 0.4);
      for (var i = 0; i < count; i++) {
        var ei = Math.floor(Math.random() * dag.edges.length);
        var e = dag.edges[ei];
        var pkt = createPacket(e, dag);
        // stagger positions
        pkt.s = Math.random() * e.lut.len;
        this._packets.push(pkt);
      }
    },

    _maxPackets: function () {
      var area = this._W * this._H;
      var base = Math.round(clamp(area / 14000, 30, 80));
      return this._reducedMotion ? Math.floor(base * 0.5) : base;
    },

    _handleClick: function (mx, my) {
      var dag = this._dag;
      if (!dag) return;
      var nodes = dag.nodes;
      var best = null, bestD = 28 * this._dpr; // click radius
      var i;

      for (i = 0; i < nodes.length; i++) {
        var dx = nodes[i].x - mx, dy = nodes[i].y - my;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d < bestD) { bestD = d; best = i; }
      }

      // ── expanding ring ripple at click point ──
      if (this._ripples.length >= 4) this._ripples.shift(); // prune oldest
      this._ripples.push({ x: mx, y: my, t: 0, maxR: 120 * this._dpr });

      // ── radial nudge for nearby nodes ──
      var nudgeRadius = 100 * this._dpr;
      for (i = 0; i < nodes.length; i++) {
        var ndx = nodes[i].x - mx, ndy = nodes[i].y - my;
        var nd = Math.sqrt(ndx * ndx + ndy * ndy);
        if (nd < nudgeRadius && nd > 0.5) {
          var nudgeMag = 6 * this._dpr * (1 - nd / nudgeRadius);
          nodes[i].nudgeVX += (ndx / nd) * nudgeMag;
          nodes[i].nudgeVY += (ndy / nd) * nudgeMag;
        }
      }

      if (best !== null) {
        // staggered burst: queue packets with individual delays over ~0.45s
        var burst = 4 + Math.floor(Math.random() * 3);
        var max = this._maxPackets();
        for (var b = 0; b < burst; b++) {
          this._pendingPackets.push({
            nodeIdx: best,
            delay: b * (0.45 / burst),
            speed: 90 + Math.random() * 60,
            max: max
          });
        }
        nodes[best].pulse = 1.0;
      }
    },

    _idleSpawn: function () {
      var dag = this._dag;
      if (!dag) return;
      var sources = dag.layerNodes[0];
      var src = sources[Math.floor(Math.random() * sources.length)];
      var max = this._maxPackets();
      // spawn a small train: 2–4 packets
      var train = 2 + Math.floor(Math.random() * 3);
      for (var i = 0; i < train; i++) {
        if (this._packets.length < max) {
          spawnFromNode(src, dag, this._packets, max);
        }
      }
    },

    _tick: function (now) {
      var self = this;
      if (this._hidden) return;
      if (!this._canvas || !this._ctx) return;

      var dt = this._lastTime ? Math.min((now - this._lastTime) / 1000, 0.05) : 0.016;
      this._lastTime = now;
      if (this._reducedMotion) dt *= 0.5;

      this._update(dt);
      this._draw();

      this._raf = requestAnimationFrame(function (t) { self._tick(t); });
    },

    _update: function (dt) {
      var dag = this._dag;
      if (!dag) return;
      var nodes = dag.nodes;
      var edges = dag.edges;
      var packets = this._packets;
      var max = this._maxPackets();
      var t = performance.now() / 1000;
      var i, e;

      // ── periodic layout morph ──────────────────────────────────────────
      if (!this._reducedMotion) {
        this._morphTimer += dt;
        if (this._morphTimer >= this._morphNextInterval) {
          this._morphTimer = 0;
          // next interval with ±5s deterministic-ish variance
          this._morphNextInterval = this._morphInterval + (Math.random() * 2 - 1) * this._morphVariance;
          this._startMorph(dag);
        }
        if (this._morphing) {
          this._updateMorph(dag, dt);
        }
      }

      // ── node breathing + morph lerp ────────────────────────────────────
      for (i = 0; i < nodes.length; i++) {
        var n = nodes[i];

        // breathing offset stored for draw-time only (does not mutate x/y or force LUT rebuild)
        n.breathX = Math.sin(t * n.speedX + n.phaseX) * 4;
        n.breathY = Math.sin(t * n.speedY + n.phaseY) * 4;
        n.x = n.bx;
        n.y = n.by;

        // nudge spring (click effect)
        var SPRING = 120, DAMP = 14;
        n.nudgeVX += (-SPRING * n.nudgeX - DAMP * n.nudgeVX) * dt;
        n.nudgeVY += (-SPRING * n.nudgeY - DAMP * n.nudgeVY) * dt;
        n.nudgeX += n.nudgeVX * dt;
        n.nudgeY += n.nudgeVY * dt;
        if (Math.abs(n.nudgeX) < 0.01 && Math.abs(n.nudgeVX) < 0.01) { n.nudgeX = 0; n.nudgeVX = 0; }
        if (Math.abs(n.nudgeY) < 0.01 && Math.abs(n.nudgeVY) < 0.01) { n.nudgeY = 0; n.nudgeVY = 0; }

        if (n.pulse > 0) n.pulse = Math.max(0, n.pulse - dt * 2.2);
      }

      // recompute edge LUTs only during morph (breathing is now draw-time only)
      if (this._morphing) recomputeLUTs(dag);

      // ── lineage highlight + focus scalar ──────────────────────────────
      var mx = this._mouse.x, my = this._mouse.y;
      var nodeHoverThresh = 36 * this._dpr;
      var edgeHoverThresh = 28 * this._dpr;

      // find hovered node or edge
      var hoveredNodes = [];
      var hoveredViaEdge = false;
      var ni;
      for (ni = 0; ni < nodes.length; ni++) {
        var ndx2 = nodes[ni].x - mx, ndy2 = nodes[ni].y - my;
        if (Math.sqrt(ndx2 * ndx2 + ndy2 * ndy2) < nodeHoverThresh) {
          hoveredNodes.push(ni);
        }
      }
      if (hoveredNodes.length === 0) {
        // check edges
        for (e = 0; e < edges.length; e++) {
          if (distToLUT(edges[e].lut, mx, my) < edgeHoverThresh) {
            // add both endpoints
            var ef = edges[e].from, et = edges[e].to;
            if (hoveredNodes.indexOf(ef) < 0) hoveredNodes.push(ef);
            if (hoveredNodes.indexOf(et) < 0) hoveredNodes.push(et);
            hoveredViaEdge = true;
          }
        }
      }

      var lineage = null;
      var anyHovered = hoveredNodes.length > 0;
      if (anyHovered) {
        lineage = computeLineage(hoveredNodes, dag);
      }

      // ease focus scalar
      this._focusTarget = anyHovered ? 1 : 0;
      this._focusScalar += (this._focusTarget - this._focusScalar) * Math.min(1, dt * 6);

      // ease node h values
      for (ni = 0; ni < nodes.length; ni++) {
        var nh = nodes[ni];
        nh.hTarget = (lineage && lineage.nodeSet[ni]) ? 1 : 0;
        nh.h += (nh.hTarget - nh.h) * Math.min(1, dt * 6);
      }

      // ease edge h values (also update legacy highlight for shimmer compatibility)
      for (e = 0; e < edges.length; e++) {
        var edge = edges[e];
        edge.hTarget = (lineage && lineage.edgeSet[e]) ? 1 : 0;
        edge.h += (edge.hTarget - edge.h) * Math.min(1, dt * 6);
        // legacy proximity highlight (kept for base draw alpha)
        var proxD = distToLUT(edge.lut, mx, my);
        var proxThresh = 40 * this._dpr;
        var proxTarget = proxD < proxThresh ? clamp((proxThresh - proxD) / proxThresh, 0, 1) : 0;
        edge.highlight += (proxTarget - edge.highlight) * Math.min(1, dt * 6);
        // advance shimmer
        edge.shimmerPhase += edge.shimmerSpeed * dt;
        if (edge.lut && edge.shimmerPhase > edge.lut.len + 80 * this._dpr) {
          edge.shimmerPhase -= edge.lut.len + 80 * this._dpr;
        }
      }

      // ── parallax lerp ─────────────────────────────────────────────────
      if (!this._reducedMotion) {
        var cx = this._W * 0.5, cy = this._H * 0.5;
        var rawPX = (this._mouse.x - cx) * 0.018;
        var rawPY = (this._mouse.y - cy) * 0.018;
        // only apply when mouse is on canvas (not at default off-screen pos)
        var mouseOnScreen = this._mouse.x > -9000;
        var targetPX = mouseOnScreen ? rawPX : 0;
        var targetPY = mouseOnScreen ? rawPY : 0;
        this._parallaxX = lerp(this._parallaxX, targetPX, Math.min(1, dt * 0.04 * 60));
        this._parallaxY = lerp(this._parallaxY, targetPY, Math.min(1, dt * 0.04 * 60));
      }

      // ── update packets ─────────────────────────────────────────────────
      var alive = [];
      var arrivals = []; // {nodeIdx, speed}
      for (var p = 0; p < packets.length; p++) {
        var pkt = packets[p];
        var pktEdge = pkt.edge;
        var spd = pkt.speed;
        pkt.s += spd * dt;
        pkt.alpha = Math.min(1, pkt.alpha + dt * 4);
        if (pkt.s >= pktEdge.lut.len) {
          var destIdx = pktEdge.to;
          nodes[destIdx].pulse = Math.max(nodes[destIdx].pulse, 0.85);
          arrivals.push({ nodeIdx: destIdx, speed: spd });
          pkt.done = true;
        } else {
          alive.push(pkt);
        }
      }
      this._packets = alive;

      // cascade: forward packets from arrived destinations
      for (var a = 0; a < arrivals.length; a++) {
        var arr = arrivals[a];
        var destNode = nodes[arr.nodeIdx];
        if (destNode.layer < dag.layerNodes.length - 1) {
          if (Math.random() < 0.7 && this._packets.length < max) {
            spawnFromNode(arr.nodeIdx, dag, this._packets, max, arr.speed * (0.85 + Math.random() * 0.3));
          }
        }
      }

      // ── process pending staggered click packets ────────────────────────
      if (this._pendingPackets.length > 0) {
        this._pendingTimer += dt;
        var remaining = [];
        for (var pp = 0; pp < this._pendingPackets.length; pp++) {
          var pd = this._pendingPackets[pp];
          if (this._pendingTimer >= pd.delay) {
            if (this._packets.length < pd.max * 1.5) {
              spawnFromNode(pd.nodeIdx, dag, this._packets, pd.max * 1.5, pd.speed);
            }
          } else {
            remaining.push(pd);
          }
        }
        this._pendingPackets = remaining;
        if (this._pendingPackets.length === 0) this._pendingTimer = 0;
      }

      // ── ripple update ──────────────────────────────────────────────────
      var aliveRipples = [];
      for (var ri = 0; ri < this._ripples.length; ri++) {
        this._ripples[ri].t += dt;
        if (this._ripples[ri].t < 0.8) aliveRipples.push(this._ripples[ri]);
      }
      this._ripples = aliveRipples;

      // ── idle spawn timer ───────────────────────────────────────────────
      this._idleTimer += dt * 1000;
      var interval = this._reducedMotion ? this._idleInterval * 2 : this._idleInterval;
      if (this._idleTimer > interval) {
        this._idleTimer = 0;
        if (this._packets.length < max * 0.8) this._idleSpawn();
      }
    },

    // ── morph helpers ──────────────────────────────────────────────────────

    _startMorph: function (dag) {
      var nodes = dag.nodes;
      var layerNodes = dag.layerNodes;
      var H = this._H;
      var yMarginTop = H * 0.12;
      var yMarginBot = H * 0.88;
      var minSpacing = (yMarginBot - yMarginTop) / 8; // ensure min gap

      this._morphing = true;

      for (var li = 0; li < layerNodes.length; li++) {
        var layer = layerNodes[li];
        var count = layer.length;
        // generate new y positions within the band, shuffled
        var newYs = [];
        var j;
        for (j = 0; j < count; j++) {
          var yFrac = count === 1 ? 0.5 : j / (count - 1);
          var baseY = yMarginTop + yFrac * (yMarginBot - yMarginTop);
          // jitter within band but keep reasonable spacing
          var jitter = (Math.random() * 2 - 1) * minSpacing * 0.7;
          newYs.push(clamp(baseY + jitter, yMarginTop + 10, yMarginBot - 10));
        }
        // small x jitter
        for (j = 0; j < count; j++) {
          var ni = layer[j];
          var node = nodes[ni];
          node.morphSrcX = node.bx;
          node.morphSrcY = node.by;
          node.morphTargetX = node.bx + (Math.random() * 2 - 1) * 12 * this._dpr;
          node.morphTargetY = newYs[j];
          node.morphT = 0;
        }
      }
    },

    _updateMorph: function (dag, dt) {
      var MORPH_DURATION = 2.5; // seconds
      var nodes = dag.nodes;
      var allDone = true;

      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (n.morphT < 1) {
          n.morphT = Math.min(1, n.morphT + dt / MORPH_DURATION);
          var et = easeInOut(n.morphT);
          n.bx = lerp(n.morphSrcX, n.morphTargetX, et);
          n.by = lerp(n.morphSrcY, n.morphTargetY, et);
          if (n.morphT < 1) allDone = false;
        }
      }

      if (allDone) {
        this._morphing = false;
        // finalize positions
        for (var j = 0; j < nodes.length; j++) {
          nodes[j].bx = nodes[j].morphTargetX;
          nodes[j].by = nodes[j].morphTargetY;
          nodes[j].morphT = 1;
        }
      }
    },

    // ── draw ──────────────────────────────────────────────────────────────

    _draw: function () {
      var ctx = this._ctx;
      var W = this._W, H = this._H;
      var dark = this._theme === 'dark';
      var dag = this._dag;
      if (!dag) return;

      // background
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = dark ? '#0b0f1a' : '#f6f8fa';
      ctx.fillRect(0, 0, W, H);

      var dpr = this._dpr;
      var nodes = dag.nodes;
      var edges = dag.edges;
      var packets = this._packets;
      var focus = this._focusScalar; // [0,1], eased

      // ── parallax translate ─────────────────────────────────────────────
      ctx.save();
      ctx.translate(this._parallaxX, this._parallaxY);

      // ── edges ──────────────────────────────────────────────────────────
      ctx.lineCap = 'round';

      for (var e = 0; e < edges.length; e++) {
        var edge = edges[e];
        var hl = edge.highlight;
        var lineageH = edge.h; // [0,1] lineage highlight

        // dim factor: when focus active, non-lineage dims to 65%
        var dimFactor = focus > 0.001 ? lerp(1, 0.65, focus * (1 - lineageH)) : 1;

        // faint base stroke
        var baseAlpha = (dark ? 0.09 + hl * 0.14 : 0.10 + hl * 0.11) * dimFactor;
        // lineage brightening
        baseAlpha = lerp(baseAlpha, dark ? 0.45 : 0.38, lineageH);
        var baseWidth = (1.0 + hl * 0.7 + lineageH * 0.7) * dpr;

        ctx.globalAlpha = baseAlpha;
        ctx.lineWidth = baseWidth;
        ctx.strokeStyle = dark
          ? (hl > 0.3 || lineageH > 0.3 ? '#38bdf8' : '#818cf8')
          : (hl > 0.3 || lineageH > 0.3 ? '#0ea5e9' : '#6366f1');

        ctx.beginPath();
        ctx.moveTo(edge.p0.x, edge.p0.y);
        ctx.bezierCurveTo(edge.p1.x, edge.p1.y, edge.p2.x, edge.p2.y, edge.p3.x, edge.p3.y);
        ctx.stroke();

        // extra highlight pass — slightly thicker, more opaque
        var combinedHL = Math.max(hl, lineageH);
        if (combinedHL > 0.05) {
          ctx.globalAlpha = combinedHL * (dark ? 0.22 : 0.18) * dimFactor;
          ctx.lineWidth = baseWidth * 2.2;
          ctx.strokeStyle = dark ? '#22d3ee' : '#0ea5e9';
          ctx.beginPath();
          ctx.moveTo(edge.p0.x, edge.p0.y);
          ctx.bezierCurveTo(edge.p1.x, edge.p1.y, edge.p2.x, edge.p2.y, edge.p3.x, edge.p3.y);
          ctx.stroke();
        }

        // ── ambient shimmer pulse ──────────────────────────────────────
        if (edge.lut && dimFactor > 0.3) {
          var SHIMMER_LEN = 80 * dpr;
          var shimS = edge.shimmerPhase;
          var shimHead = clamp(shimS, 0, edge.lut.len);
          var shimTail = clamp(shimS - SHIMMER_LEN, 0, edge.lut.len);
          if (shimHead > shimTail + 2) {
            var shHead = sampleLUT(edge.lut, shimHead);
            var shTail = sampleLUT(edge.lut, shimTail);
            var shimGrad = ctx.createLinearGradient(shTail.x, shTail.y, shHead.x, shHead.y);
            var shimAlpha = (dark ? 0.07 : 0.055) * dimFactor;
            shimGrad.addColorStop(0, 'rgba(0,0,0,0)');
            shimGrad.addColorStop(0.5, dark ? ('rgba(34,211,238,' + shimAlpha + ')') : ('rgba(14,165,233,' + shimAlpha + ')'));
            shimGrad.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.globalAlpha = 1;
            ctx.lineWidth = 2.0 * dpr;
            ctx.strokeStyle = shimGrad;
            ctx.beginPath();
            ctx.moveTo(shTail.x, shTail.y);
            // walk LUT segment
            var shimStep = (shimHead - shimTail) / 8;
            for (var si = 1; si <= 8; si++) {
              var spt = sampleLUT(edge.lut, shimTail + shimStep * si);
              ctx.lineTo(spt.x, spt.y);
            }
            ctx.stroke();
          }
        }
      }

      // ── nodes ──────────────────────────────────────────────────────────
      ctx.globalCompositeOperation = 'source-over';
      var nodeR = 5 * dpr;

      for (var ni = 0; ni < nodes.length; ni++) {
        var n = nodes[ni];
        var pulse = n.pulse;
        var lineageHN = n.h; // [0,1]

        // dim factor per node
        var nodeDimFactor = focus > 0.001 ? lerp(1, 0.65, focus * (1 - lineageHN)) : 1;

        // base node circle — grows ~20% when in lineage
        var nr = (nodeR + pulse * nodeR * 0.8) * (1 + lineageHN * 0.20);
        var drawX = n.x + (n.breathX || 0) + n.nudgeX;
        var drawY = n.y + (n.breathY || 0) + n.nudgeY;
        var nodeAlpha = (dark ? (0.22 + pulse * 0.55) : (0.28 + pulse * 0.45)) * nodeDimFactor;
        // brighten in lineage
        nodeAlpha = lerp(nodeAlpha, dark ? 0.92 : 0.85, lineageHN);

        ctx.globalAlpha = nodeAlpha;
        ctx.fillStyle = this._nodeColor(n.layer, dag.layerNodes.length, dark);
        ctx.beginPath();
        ctx.arc(drawX, drawY, nr, 0, Math.PI * 2);
        ctx.fill();

        // inner dot
        ctx.globalAlpha = (nodeAlpha * 0.7 + 0.1) * nodeDimFactor;
        ctx.fillStyle = dark ? '#e2e8f0' : '#1e293b';
        ctx.beginPath();
        ctx.arc(drawX, drawY, nr * 0.38, 0, Math.PI * 2);
        ctx.fill();

        // pulse ring
        if (pulse > 0.05) {
          var ringR = nr + pulse * nodeR * 2.2;
          ctx.globalAlpha = pulse * (dark ? 0.35 : 0.28) * nodeDimFactor;
          ctx.strokeStyle = this._nodeColor(n.layer, dag.layerNodes.length, dark);
          ctx.lineWidth = 1.2 * dpr;
          ctx.beginPath();
          ctx.arc(drawX, drawY, ringR, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      // ── packets ────────────────────────────────────────────────────────
      if (dark) ctx.globalCompositeOperation = 'lighter';
      else ctx.globalCompositeOperation = 'source-over';

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      for (var p = 0; p < packets.length; p++) {
        var pkt = packets[p];
        var lut = pkt.edge.lut;
        var progress = pkt.s / lut.len;
        var a = pkt.alpha * easeInOut(Math.min(1, Math.min(progress * 5, (1 - progress) * 5)));
        if (a < 0.01) continue;

        var headPos = sampleLUT(lut, pkt.s);

        // Packet sizes +~35%: streak 46→60px, head width 2.5→3.4px, core 1.0→1.35px, cap 1.2→1.65px
        var STREAK_LEN = 60 * dpr;
        var TRAIL_STEPS = 8;
        var trailPts = [];
        for (var ti = 0; ti <= TRAIL_STEPS; ti++) {
          var ts = clamp(pkt.s - STREAK_LEN * (ti / TRAIL_STEPS), 0, lut.len);
          trailPts.push(sampleLUT(lut, ts));
        }

        var tailPos = trailPts[TRAIL_STEPS];

        // Layer 1 — wide soft body (3.4px head width)
        var grad1 = ctx.createLinearGradient(tailPos.x, tailPos.y, headPos.x, headPos.y);
        grad1.addColorStop(0, 'rgba(0,0,0,0)');
        grad1.addColorStop(0.55, dark ? 'rgba(56,189,248,0.18)' : 'rgba(14,165,233,0.14)');
        grad1.addColorStop(1, dark ? 'rgba(34,211,238,0.55)' : 'rgba(14,165,233,0.45)');

        ctx.globalAlpha = a;
        ctx.lineWidth = 3.4 * dpr;
        ctx.strokeStyle = grad1;
        ctx.beginPath();
        ctx.moveTo(tailPos.x, tailPos.y);
        for (var ti2 = TRAIL_STEPS - 1; ti2 >= 0; ti2--) {
          ctx.lineTo(trailPts[ti2].x, trailPts[ti2].y);
        }
        ctx.stroke();

        // Layer 2 — thin bright core (1.35px), shorter (60% of streak)
        var shortLen = STREAK_LEN * 0.6;
        var midPos = sampleLUT(lut, clamp(pkt.s - shortLen, 0, lut.len));
        var grad2 = ctx.createLinearGradient(midPos.x, midPos.y, headPos.x, headPos.y);
        grad2.addColorStop(0, 'rgba(0,0,0,0)');
        grad2.addColorStop(1, dark ? 'rgba(224,247,255,0.92)' : 'rgba(30,58,95,0.80)');

        ctx.globalAlpha = a;
        ctx.lineWidth = 1.35 * dpr;
        ctx.strokeStyle = grad2;
        ctx.beginPath();
        ctx.moveTo(midPos.x, midPos.y);
        for (var ti3 = TRAIL_STEPS - 1; ti3 >= 0; ti3--) {
          var ts3 = clamp(pkt.s - STREAK_LEN * (ti3 / TRAIL_STEPS), 0, lut.len);
          if (ts3 >= pkt.s - shortLen) {
            ctx.lineTo(trailPts[ti3].x, trailPts[ti3].y);
          }
        }
        ctx.stroke();

        // Head cap — 1.65px radius circle (up from 1.2px)
        ctx.globalAlpha = a * (dark ? 0.95 : 0.80);
        ctx.fillStyle = dark ? '#e0f7ff' : '#1e3a5f';
        ctx.beginPath();
        ctx.arc(headPos.x, headPos.y, 1.65 * dpr, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';

      // ── ripples ────────────────────────────────────────────────────────
      for (var ri = 0; ri < this._ripples.length; ri++) {
        var rip = this._ripples[ri];
        var rp = rip.t / 0.8; // 0→1
        var rEase = 1 - Math.pow(1 - rp, 2); // ease-out
        var rAlpha = (1 - rp) * (dark ? 0.55 : 0.45);
        var rRadius = rip.maxR * rEase;

        ctx.globalAlpha = rAlpha;
        ctx.strokeStyle = dark ? '#22d3ee' : '#0ea5e9';
        ctx.lineWidth = 1.5 * dpr;
        ctx.beginPath();
        ctx.arc(rip.x, rip.y, rRadius, 0, Math.PI * 2);
        ctx.stroke();

        // second concentric ring, offset by ~0.12s
        var rp2 = clamp((rip.t - 0.1) / 0.8, 0, 1);
        if (rp2 > 0) {
          var rEase2 = 1 - Math.pow(1 - rp2, 2);
          var rAlpha2 = (1 - rp2) * (dark ? 0.30 : 0.22);
          ctx.globalAlpha = rAlpha2;
          ctx.lineWidth = 1.0 * dpr;
          ctx.beginPath();
          ctx.arc(rip.x, rip.y, rip.maxR * rEase2 * 0.65, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      ctx.globalAlpha = 1;
      ctx.restore(); // end parallax translate
    },

    _nodeColor: function (layer, totalLayers, dark) {
      if (dark) {
        if (layer === 0) return '#22d3ee';
        if (layer === totalLayers - 1) return '#38bdf8';
        return '#818cf8';
      } else {
        if (layer === 0) return '#0ea5e9';
        if (layer === totalLayers - 1) return '#0ea5e9';
        return '#6366f1';
      }
    }
  };

}());
