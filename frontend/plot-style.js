/* plot-style.js - client-side appearance for the plot.
 *
 * The backend hands us a ROOT TCanvas serialized with TBufferJSON. Everything
 * here restyles that object in the browser and lets app.js redraw it with
 * JSROOT - no backend call. It only touches how the plot LOOKS (axis scale,
 * grid, which boxes show, marker/line appearance); it never changes what ROOT
 * computed. Fields set here (fLogx, fGridx, fMarkerColor, fLineStyle, …) are
 * standard ROOT attributes JSROOT reads when it draws.
 */
(function () {
  'use strict';

  // ROOT colour indices - JSROOT ships the full ROOT colour table, so these
  // high-level indices render the expected colours.
  const COLORS = [
    { name: 'Default', v: 0 },
    { name: 'Black', v: 1 },
    { name: 'Red', v: 632 },
    { name: 'Blue', v: 600 },
    { name: 'Green', v: 418 },
    { name: 'Orange', v: 800 },
    { name: 'Purple', v: 616 },
    { name: 'Teal', v: 840 },
    { name: 'Gray', v: 920 },
  ];
  const MARKERS = [
    { name: 'Default', v: 0 },
    { name: 'Circle ●', v: 20 },
    { name: 'Square ■', v: 21 },
    { name: 'Triangle ▲', v: 22 },
    { name: 'Diamond ◆', v: 33 },
    { name: 'Star ★', v: 29 },
    { name: 'Open circle ○', v: 24 },
    { name: 'Open square □', v: 25 },
    { name: 'Cross ✚', v: 34 },
  ];
  const MARKER_SIZES = [
    { name: 'Default', v: 0 }, { name: 'Small', v: 0.8 }, { name: 'Medium', v: 1.3 },
    { name: 'Large', v: 1.8 }, { name: 'X-large', v: 2.5 },
  ];
  const LINE_STYLES = [
    { name: 'Default', v: 0 }, { name: 'Solid', v: 1 }, { name: 'Dashed', v: 2 },
    { name: 'Dotted', v: 3 }, { name: 'Dash-dot', v: 7 },
  ];
  const LINE_WIDTHS = [
    { name: 'Default', v: 0 }, { name: 'Thin', v: 1 }, { name: 'Medium', v: 2 },
    { name: 'Thick', v: 3 }, { name: 'Extra thick', v: 5 },
  ];

  const DEFAULTS = {
    logx: false, logy: false, gridx: false, gridy: false,
    stats: true, legend: true, title: true,
    markerColor: 0, markerStyle: 0, markerSize: 0,
    lineColor: 0, lineWidth: 0, lineStyle: 0,
  };

  const KEY = 'rootfit.plotstyle';

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
      return { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
    } catch (_) { return { ...DEFAULTS }; }
  }
  function save(style) {
    try { localStorage.setItem(KEY, JSON.stringify(style)); } catch (_) { /* private mode */ }
  }

  function clone(obj) {
    try { if (typeof structuredClone === 'function') return structuredClone(obj); } catch (_) { /* fall through */ }
    return JSON.parse(JSON.stringify(obj));
  }

  const isPad = (n) => n && n._typename && Object.prototype.hasOwnProperty.call(n, 'fLogx');

  /** Read the axis/grid state of the drawn canvas (prefer a real sub-pad). */
  function readAxes(json) {
    if (!json || typeof json !== 'object') return null;
    let pad = null;
    (function scan(n) {
      if (pad || !n || typeof n !== 'object') return;
      if (isPad(n) && n._typename !== 'TCanvas') { pad = n; return; }
      for (const k of Object.keys(n)) {
        const v = n[k];
        if (v && typeof v === 'object') {
          if (Array.isArray(v.arr)) v.arr.forEach(scan);
          else scan(v);
        }
        if (pad) return;
      }
    })(json);
    if (!pad && isPad(json)) pad = json;
    if (!pad) return null;
    return { logx: !!pad.fLogx, logy: !!pad.fLogy, gridx: !!pad.fGridx, gridy: !!pad.fGridy };
  }

  function applyPad(node, s) {
    if (!isPad(node)) return;
    node.fLogx = s.logx ? 1 : 0;
    node.fLogy = s.logy ? 1 : 0;
    node.fGridx = s.gridx ? 1 : 0;
    node.fGridy = s.gridy ? 1 : 0;
  }

  function applyAttrs(node, s, opt) {
    const t = node._typename || '';
    const O = (opt || '').toUpperCase();
    if (/^TGraph/.test(t) && O.indexOf('P') >= 0) {   // the data points
      if (s.markerColor) node.fMarkerColor = s.markerColor;
      if (s.markerStyle) node.fMarkerStyle = s.markerStyle;
      if (s.markerSize) node.fMarkerSize = s.markerSize;
    }
    if (/^TF\d/.test(t)) {                            // the fitted curve
      if (s.lineColor) node.fLineColor = s.lineColor;
      if (s.lineWidth) node.fLineWidth = s.lineWidth;
      if (s.lineStyle) node.fLineStyle = s.lineStyle;
    }
  }

  function shouldRemove(it, s) {
    const t = it && it._typename;
    if (t === 'TPaveStats' && s.stats === false) return true;
    if (t === 'TLegend' && s.legend === false) return true;
    if (t === 'TPaveText' && it.fName === 'title' && s.title === false) return true;
    return false;
  }

  /** Walk a node: style it, then recurse into its ROOT lists, dropping any
   *  primitive the style hides. Lists carry a parallel `opt` (draw options). */
  function styleNode(node, s, opt) {
    if (!node || typeof node !== 'object') return;
    applyPad(node, s);
    applyAttrs(node, s, opt);
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (v && typeof v === 'object' && Array.isArray(v.arr)) {
        const arr = v.arr;
        const opts = v.opt || [];
        const keepArr = [];
        const keepOpt = [];
        for (let i = 0; i < arr.length; i++) {
          const it = arr[i];
          if (shouldRemove(it, s)) continue;
          styleNode(it, s, opts[i] || '');
          keepArr.push(it);
          if (v.opt) keepOpt.push(opts[i]);
        }
        v.arr = keepArr;
        if (v.opt) v.opt = keepOpt;
      }
    }
  }

  /** A restyled deep copy of the canvas JSON. The input is never mutated. */
  function styledCanvas(json, style) {
    if (!json || typeof json !== 'object') return json;
    const s = { ...DEFAULTS, ...(style || {}) };
    const root = clone(json);
    styleNode(root, s, '');
    return root;
  }

  window.PlotStyle = {
    DEFAULTS, COLORS, MARKERS, MARKER_SIZES, LINE_STYLES, LINE_WIDTHS,
    load, save, styledCanvas, readAxes,
  };
})();
