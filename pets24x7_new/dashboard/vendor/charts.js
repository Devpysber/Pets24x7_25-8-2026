/* Small hand-drawn SVG charts for the vendor dashboard (no chart library).
   Every chart has a hover/tap tooltip and, where it plots a series, a
   "Show as table" view so nothing is read from colour alone.

   VChart.line(el, rows, series, opts)   rows: [{label, a: n, b: n}], series: [{key, name, color}]
   VChart.bars(el, rows, opts)           rows: [{label, value, hint?}]
   VChart.split(el, parts, opts)         parts: [{name, value, color}] -> one 100% bar + legend
   VChart.funnel(el, steps)              steps: [{name, value}]
   VChart.hbars(el, rows, opts)          rows: [{label, value}] horizontal bars
   VChart.spark(rows, key, color)        -> inline SVG string (no axes) */
(function () {
  'use strict';

  var css = document.createElement('style');
  css.textContent =
    '.vc{position:relative;font-size:12px;color:var(--text-muted,#64748B)}' +
    '.vc svg{display:block;max-width:100%;height:auto;overflow:visible}' +
    '.vc .vc-grid{stroke:#EEF2F6;stroke-width:1}' +
    '.vc .vc-axis{fill:#94A3B8;font-size:11px}' +
    '.vc .vc-cross{stroke:#94A3B8;stroke-width:1;stroke-dasharray:3 3}' +
    '.vc-tip{position:absolute;pointer-events:none;background:#0F172A;color:#fff;border-radius:8px;padding:7px 10px;font-size:12px;line-height:1.45;' +
    'white-space:nowrap;box-shadow:0 6px 18px rgba(15,23,42,.18);z-index:5;transform:translate(-50%,calc(-100% - 10px));opacity:0;transition:opacity .08s}' +
    '.vc-tip.on{opacity:1}' +
    '.vc-tip b{font-weight:700}' +
    '.vc-tip i,.vc-legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px;vertical-align:0}' +
    '.vc-legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:10px;font-size:12.5px;color:var(--text-main,#0F172A)}' +
    '.vc-legend span{display:inline-flex;align-items:center}' +
    '.vc-legend em{font-style:normal;color:var(--text-muted,#64748B);margin-left:4px}' +
    '.vc-table{margin-top:8px;font-size:12.5px}' +
    '.vc-table summary{cursor:pointer;color:var(--primary,#2563EB);font-weight:600;width:max-content}' +
    '.vc-table table{border-collapse:collapse;margin-top:6px;width:100%;max-width:420px}' +
    '.vc-table th,.vc-table td{text-align:left;padding:4px 8px;border-bottom:1px solid #EEF2F6}' +
    '.vc-table td+td,.vc-table th+th{text-align:right}' +
    '.vc-split{display:flex;height:14px;border-radius:7px;overflow:hidden;background:#EEF2F6;gap:2px}' +
    '.vc-split div{height:100%;min-width:3px}' +
    '.vc-row{display:grid;grid-template-columns:minmax(80px,140px) 1fr auto;align-items:center;gap:10px;padding:5px 0}' +
    '.vc-row .vc-lbl{color:var(--text-main,#0F172A);font-weight:600;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.vc-row .vc-track{height:14px;background:#F1F5F9;border-radius:0 4px 4px 0;position:relative}' +
    '.vc-row .vc-fill{position:absolute;left:0;top:0;bottom:0;border-radius:0 4px 4px 0}' +
    '.vc-row .vc-val{font-variant-numeric:tabular-nums;color:var(--text-main,#0F172A);font-weight:700;font-size:12.5px;min-width:44px;text-align:right}' +
    '.vc-row .vc-val em{font-style:normal;font-weight:500;color:var(--text-muted,#64748B);margin-left:4px}' +
    '.vc-empty{padding:18px 0;color:var(--text-muted,#64748B);font-size:13px}';
  (document.head || document.documentElement).appendChild(css);

  function esc(s) { return String(s == null ? '' : s).replace(/[<>&"']/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function num(n) { return Number(n || 0).toLocaleString('en-IN'); }

  // A tidy axis maximum and ~4 ticks: 0, step, 2*step, ...
  function niceMax(max) {
    if (max <= 4) return { max: 4, step: 1 };
    var raw = max / 4, pow = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / pow;
    var step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
    return { max: Math.ceil(max / step) * step, step: step };
  }

  function tipFor(el) {
    var t = el.querySelector('.vc-tip');
    if (!t) { t = document.createElement('div'); t.className = 'vc-tip'; t.setAttribute('aria-hidden', 'true'); el.appendChild(t); }
    return t;
  }
  function showTip(el, html, x, y) {
    var t = tipFor(el);
    t.innerHTML = html;
    var w = el.clientWidth, half = (t.offsetWidth || 120) / 2;
    t.style.left = Math.max(half, Math.min(w - half, x)) + 'px';
    t.style.top = y + 'px';
    t.classList.add('on');
  }
  function hideTip(el) { var t = el.querySelector('.vc-tip'); if (t) t.classList.remove('on'); }

  function table(caption, head, rows) {
    return '<details class="vc-table"><summary>Show as table</summary><table><caption class="sr-only" style="position:absolute;left:-9999px">' + esc(caption) + '</caption><thead><tr>' +
      head.map(function (h) { return '<th scope="col">' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + esc(c) + '</td>'; }).join('') + '</tr>'; }).join('') +
      '</tbody></table></details>';
  }

  function legend(items) {
    return '<div class="vc-legend">' + items.map(function (s) {
      return '<span><i style="background:' + s.color + '"></i>' + esc(s.name) + (s.extra != null ? '<em>' + esc(s.extra) + '</em>' : '') + '</span>';
    }).join('') + '</div>';
  }

  // Multi-series line chart on one shared count axis, with a crosshair.
  // Charts are drawn at the container's real pixel width, so axis text keeps
  // its size on a phone; a resize redraws them.
  var drawn = [];
  function remember(el, fn, args) {
    for (var i = 0; i < drawn.length; i++) if (drawn[i].el === el) { drawn[i].fn = fn; drawn[i].args = args; return; }
    drawn.push({ el: el, fn: fn, args: args });
  }
  var resizeT;
  window.addEventListener('resize', function () {
    clearTimeout(resizeT);
    resizeT = setTimeout(function () {
      drawn.forEach(function (d) {
        if (d.el.isConnected && d.el.offsetWidth && Math.abs(d.el.offsetWidth - (d.w || 0)) > 8) d.fn.apply(null, d.args);
      });
    }, 150);
  });
  function widthOf(el) {
    var w = el.clientWidth;
    if (!w) return 600; // hidden tab: drawn again when shown
    return Math.max(260, w);
  }

  function line(el, rows, series, opts) {
    opts = opts || {};
    remember(el, line, [el, rows, series, opts]);
    var W = widthOf(el), H = opts.height || 180, L = 34, R = 8, T = 10, B = 22;
    var max = 0;
    rows.forEach(function (r) { series.forEach(function (s) { max = Math.max(max, Number(r[s.key]) || 0); }); });
    var nm = niceMax(max), n = rows.length;
    var x = function (i) { return L + (n === 1 ? (W - L - R) / 2 : i * (W - L - R) / (n - 1)); };
    var y = function (v) { return T + (H - T - B) * (1 - v / nm.max); };
    var s = '';
    for (var v = 0; v <= nm.max + 1e-9; v += nm.step) {
      s += '<line class="vc-grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v).toFixed(1) + '" y2="' + y(v).toFixed(1) + '"/>' +
        '<text class="vc-axis" x="' + (L - 6) + '" y="' + (y(v) + 3.5).toFixed(1) + '" text-anchor="end">' + num(v) + '</text>';
    }
    var every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(W / 90))));
    rows.forEach(function (r, i) {
      if (i % every === 0 || i === n - 1) s += '<text class="vc-axis" x="' + x(i).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="' + (i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle') + '">' + esc(r.short || r.label) + '</text>';
    });
    series.forEach(function (sr) {
      var pts = rows.map(function (r, i) { return x(i).toFixed(1) + ',' + y(Number(r[sr.key]) || 0).toFixed(1); });
      if (sr.area) s += '<polygon points="' + x(0).toFixed(1) + ',' + y(0).toFixed(1) + ' ' + pts.join(' ') + ' ' + x(n - 1).toFixed(1) + ',' + y(0).toFixed(1) + '" fill="' + sr.color + '" opacity=".10"/>';
      s += '<polyline points="' + pts.join(' ') + '" fill="none" stroke="' + sr.color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>';
    });
    s += '<line class="vc-cross" y1="' + T + '" y2="' + (H - B) + '" x1="-10" x2="-10" style="display:none" vector-effect="non-scaling-stroke"/>';
    series.forEach(function (sr, k) { s += '<circle data-dot="' + k + '" r="4" fill="' + sr.color + '" stroke="#fff" stroke-width="2" cx="-10" cy="-10" style="display:none"/>'; });
    s += '<rect class="vc-hit" x="' + L + '" y="' + T + '" width="' + (W - L - R) + '" height="' + (H - T - B) + '" fill="transparent"/>';

    el.classList.add('vc');
    drawn.forEach(function (d) { if (d.el === el) d.w = W; });
    el.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="' + esc(opts.label || '') + '">' + s + '</svg>' +
      (series.length > 1 ? legend(series) : '') +
      table(opts.label || '', ['Date'].concat(series.map(function (q) { return q.name; })),
        rows.map(function (r) { return [r.label].concat(series.map(function (q) { return num(r[q.key]); })); }));

    var svg = el.querySelector('svg'), cross = svg.querySelector('.vc-cross'), hit = svg.querySelector('.vc-hit');
    function move(ev) {
      var box = svg.getBoundingClientRect();
      var px = ((ev.touches ? ev.touches[0].clientX : ev.clientX) - box.left) * W / box.width;
      var i = n === 1 ? 0 : Math.round((px - L) / ((W - L - R) / (n - 1)));
      i = Math.max(0, Math.min(n - 1, i));
      var r = rows[i], cx = x(i);
      cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.style.display = '';
      series.forEach(function (sr, k) {
        var d = svg.querySelector('[data-dot="' + k + '"]');
        d.setAttribute('cx', cx); d.setAttribute('cy', y(Number(r[sr.key]) || 0)); d.style.display = '';
      });
      var top = Math.min.apply(null, series.map(function (sr) { return y(Number(r[sr.key]) || 0); }));
      showTip(el, '<b>' + esc(r.label) + '</b><br>' + series.map(function (sr) {
        return '<i style="background:' + sr.color + '"></i>' + esc(sr.name) + ': <b>' + num(r[sr.key]) + '</b>';
      }).join('<br>'), cx * box.width / W, top * box.height / H);
    }
    function leave() {
      cross.style.display = 'none';
      svg.querySelectorAll('[data-dot]').forEach(function (d) { d.style.display = 'none'; });
      hideTip(el);
    }
    hit.addEventListener('mousemove', move);
    hit.addEventListener('touchstart', move, { passive: true });
    hit.addEventListener('touchmove', move, { passive: true });
    hit.addEventListener('mouseleave', leave);
    hit.addEventListener('touchend', function () { setTimeout(leave, 1200); });
  }

  // Single-series column chart.
  function bars(el, rows, opts) {
    opts = opts || {};
    remember(el, bars, [el, rows, opts]);
    var W = widthOf(el), H = opts.height || 170, L = 30, R = 6, T = 14, B = 22;
    var color = opts.color || '#2a78d6';
    var max = 0;
    rows.forEach(function (r) { max = Math.max(max, Number(r.value) || 0); });
    var nm = niceMax(max), n = rows.length, slot = (W - L - R) / n, bw = Math.min(24, slot * 0.62);
    var y = function (v) { return T + (H - T - B) * (1 - v / nm.max); };
    var s = '';
    for (var v = 0; v <= nm.max + 1e-9; v += nm.step) {
      s += '<line class="vc-grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v).toFixed(1) + '" y2="' + y(v).toFixed(1) + '"/>' +
        '<text class="vc-axis" x="' + (L - 6) + '" y="' + (y(v) + 3.5).toFixed(1) + '" text-anchor="end">' + num(v) + '</text>';
    }
    var every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(W / 70))));
    rows.forEach(function (r, i) {
      var val = Number(r.value) || 0, cx = L + slot * i + slot / 2, top = y(val), h = y(0) - top;
      if (h > 0) {
        var rr = Math.min(4, h, bw / 2);
        s += '<path data-i="' + i + '" fill="' + color + '" d="M' + (cx - bw / 2).toFixed(1) + ',' + y(0).toFixed(1) +
          'V' + (top + rr).toFixed(1) + 'Q' + (cx - bw / 2).toFixed(1) + ',' + top.toFixed(1) + ' ' + (cx - bw / 2 + rr).toFixed(1) + ',' + top.toFixed(1) +
          'H' + (cx + bw / 2 - rr).toFixed(1) + 'Q' + (cx + bw / 2).toFixed(1) + ',' + top.toFixed(1) + ' ' + (cx + bw / 2).toFixed(1) + ',' + (top + rr).toFixed(1) +
          'V' + y(0).toFixed(1) + 'Z"/>';
      }
      if (i % every === 0 || i === n - 1) s += '<text class="vc-axis" x="' + cx.toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(r.short || r.label) + '</text>';
      s += '<rect data-hit="' + i + '" x="' + (L + slot * i).toFixed(1) + '" y="' + T + '" width="' + slot.toFixed(1) + '" height="' + (H - T - B) + '" fill="transparent"/>';
    });
    el.classList.add('vc');
    drawn.forEach(function (d) { if (d.el === el) d.w = W; });
    el.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="' + esc(opts.label || '') + '">' + s + '</svg>' +
      table(opts.label || '', [opts.labelHead || 'Period', opts.valueHead || 'Count'], rows.map(function (r) { return [r.label, num(r.value)]; }));
    var svg = el.querySelector('svg');
    svg.querySelectorAll('[data-hit]').forEach(function (h) {
      function on() {
        var i = +h.getAttribute('data-hit'), r = rows[i], box = svg.getBoundingClientRect();
        svg.querySelectorAll('[data-i]').forEach(function (b) { b.style.opacity = b.getAttribute('data-i') == i ? '1' : '.45'; });
        var cx = L + slot * i + slot / 2;
        showTip(el, '<b>' + esc(r.label) + '</b><br>' + esc(r.hint || ((opts.valueHead || 'Count') + ': ')) + '<b>' + num(r.value) + '</b>',
          cx * box.width / W, y(Number(r.value) || 0) * box.height / H);
      }
      h.addEventListener('mouseenter', on);
      h.addEventListener('touchstart', on, { passive: true });
    });
    svg.addEventListener('mouseleave', function () {
      svg.querySelectorAll('[data-i]').forEach(function (b) { b.style.opacity = '1'; });
      hideTip(el);
    });
  }

  // One 100% bar split into parts, with a legend that carries the numbers.
  function split(el, parts, opts) {
    opts = opts || {};
    var total = parts.reduce(function (a, p) { return a + (Number(p.value) || 0); }, 0);
    el.classList.add('vc');
    if (!total) { el.innerHTML = '<div class="vc-empty">' + esc(opts.empty || 'Nothing recorded yet.') + '</div>'; return; }
    el.innerHTML = '<div class="vc-split" role="img" aria-label="' + esc((opts.label || '') + ': ' + parts.map(function (p) { return p.name + ' ' + num(p.value); }).join(', ')) + '">' +
      parts.filter(function (p) { return Number(p.value) > 0; }).map(function (p, i) {
        return '<div data-p="' + i + '" style="flex:' + p.value + ' 1 0;background:' + p.color + '"></div>';
      }).join('') + '</div>' +
      legend(parts.map(function (p) { return { name: p.name, color: p.color, extra: num(p.value) + ' · ' + Math.round(100 * (Number(p.value) || 0) / total) + '%' }; }));
    var shown = parts.filter(function (p) { return Number(p.value) > 0; });
    el.querySelectorAll('[data-p]').forEach(function (d) {
      function on() {
        var p = shown[+d.getAttribute('data-p')], er = el.getBoundingClientRect(), dr = d.getBoundingClientRect();
        showTip(el, '<i style="background:' + p.color + '"></i>' + esc(p.name) + ': <b>' + num(p.value) + '</b> (' + Math.round(100 * p.value / total) + '%)', dr.left - er.left + dr.width / 2, dr.top - er.top);
      }
      d.addEventListener('mouseenter', on);
      d.addEventListener('touchstart', on, { passive: true });
      d.addEventListener('mouseleave', function () { hideTip(el); });
    });
  }

  // Horizontal bars, each against the largest; optional trailing note per row.
  function hbars(el, rows, opts) {
    opts = opts || {};
    var color = opts.color || '#2a78d6';
    var max = Math.max.apply(null, rows.map(function (r) { return Number(r.value) || 0; }).concat([0]));
    el.classList.add('vc');
    el.innerHTML = rows.map(function (r) {
      var w = max ? (100 * (Number(r.value) || 0) / max) : 0;
      return '<div class="vc-row"><span class="vc-lbl" title="' + esc(r.label) + '">' + esc(r.label) + '</span>' +
        '<span class="vc-track"><span class="vc-fill" style="width:' + w.toFixed(1) + '%;background:' + (r.color || color) + '"></span></span>' +
        '<span class="vc-val">' + num(r.value) + (r.note ? '<em>' + esc(r.note) + '</em>' : '') + '</span></div>';
    }).join('');
  }

  // Funnel: each step against the first, with the step-to-step conversion.
  function funnel(el, steps) {
    var ramp = ['#BFDBFE', '#7DB0EC', '#3F86DC', '#1E5DB8'];
    hbars(el, steps.map(function (s, i) {
      var prev = i ? Number(steps[i - 1].value) || 0 : 0;
      return {
        label: s.name, value: s.value, color: ramp[Math.min(i, ramp.length - 1)],
        note: i ? (prev ? Math.round(100 * (Number(s.value) || 0) / prev) + '% of previous' : '—') : ''
      };
    }));
  }

  function spark(rows, key, color) {
    var W = 120, H = 30, n = rows.length;
    if (n < 2) return '';
    var max = Math.max.apply(null, rows.map(function (r) { return Number(r[key]) || 0; }).concat([1]));
    var pts = rows.map(function (r, i) { return (i * W / (n - 1)).toFixed(1) + ',' + (H - 2 - (H - 4) * (Number(r[key]) || 0) / max).toFixed(1); }).join(' ');
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="30" preserveAspectRatio="none" aria-hidden="true" style="display:block;margin-top:8px">' +
      '<polyline points="' + pts + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>';
  }

  window.VChart = { line: line, bars: bars, split: split, hbars: hbars, funnel: funnel, spark: spark, num: num };
})();
