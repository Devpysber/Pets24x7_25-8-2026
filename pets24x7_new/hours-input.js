/* Opening-hours picker. Enhances every <input data-hours> / <textarea data-hours>
   (and fields added later) into a day-by-day editor: open or closed, open 24
   hours, or one or two time slots per day (for a lunch break), plus quick
   presets. The original field stays in the form, hidden, and keeps holding the
   text the rest of the site already stores and shows, one line per group:

     Mon – Sat: 9:00 AM – 1:00 PM, 4:00 PM – 8:00 PM
     Sun: Closed

   Text that is not in that shape (typed before this picker existed) is left
   untouched until the person changes something here. HoursField.refresh(el)
   re-reads the field after a script sets its value. Self-contained, no deps. */
(function () {
  'use strict';

  var DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  var LONG = { monday: 0, tuesday: 1, wednesday: 2, thursday: 3, friday: 4, saturday: 5, sunday: 6 };

  var css = document.createElement('style');
  css.textContent =
    '.hr-box{border:1px solid var(--border,#E2E8F0);border-radius:12px;background:#fff;padding:12px;margin-top:0}' +
    '.hr-presets{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}' +
    '.hr-presets button{flex:0 0 auto;border:1px solid var(--border,#E2E8F0);background:var(--bg-alt,#F8FAFC);color:var(--text,#0F172A);' +
    'border-radius:999px;padding:6px 12px;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;min-height:0;box-shadow:none;width:auto}' +
    '.hr-presets button:hover{border-color:var(--primary,#2563EB);color:var(--primary,#2563EB)}' +
    '.hr-row{display:grid;grid-template-columns:92px 1fr;align-items:center;gap:8px;padding:7px 0;border-top:1px dashed var(--border,#E2E8F0)}' +
    '.hr-row:first-of-type{border-top:0}' +
    '.hr-day{display:flex;align-items:center;gap:8px;font-weight:700;font-size:14px;margin:0!important;text-transform:none!important;letter-spacing:0!important;color:var(--text,#0F172A)!important;cursor:pointer}' +
    '.hr-day input{width:18px!important;height:18px;margin:0!important;padding:0!important;accent-color:var(--primary,#2563EB);flex:0 0 auto;box-shadow:none!important}' +
    '.hr-slots{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;min-width:0}' +
    '.hr-slot{display:flex;align-items:center;gap:4px}' +
    '.hr-slot input[type=time]{width:auto!important;min-width:0;padding:7px 8px!important;font-size:14px!important;margin:0!important;border-radius:8px!important}' +
    '.hr-slot span{color:var(--text-muted,#64748B);font-size:13px}' +
    '.hr-closed{color:var(--text-muted,#64748B);font-size:13.5px;font-weight:600}' +
    '.hr-link{border:0;background:none;color:var(--primary,#2563EB);font:inherit;font-size:12.5px;font-weight:700;cursor:pointer;padding:4px 2px;min-height:0;box-shadow:none;width:auto}' +
    '.hr-link.hr-x{color:var(--text-muted,#64748B);font-size:16px;line-height:1;padding:2px 6px}' +
    '.hr-24{display:flex;align-items:center;gap:5px;font-size:12.5px;font-weight:600;margin:0!important;text-transform:none!important;letter-spacing:0!important;color:var(--text-muted,#64748B)!important;cursor:pointer}' +
    '.hr-24 input{width:15px!important;height:15px;margin:0!important;padding:0!important;accent-color:var(--primary,#2563EB);box-shadow:none!important}' +
    '.hr-note{font-size:12.5px;color:#92400E;background:#FFFBEB;border:1px solid #FDE68A;border-radius:8px;padding:8px 10px;margin-bottom:10px;white-space:pre-line}' +
    '.hr-preview{font-size:12.5px;color:var(--text-muted,#64748B);margin-top:8px;white-space:pre-line}' +
    '@media (max-width:480px){.hr-row{grid-template-columns:1fr}.hr-slots{padding-left:26px}}';
  (document.head || document.documentElement).appendChild(css);

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // "09:00" -> "9:00 AM"
  function to12(t) {
    var m = /^(\d{1,2}):(\d{2})/.exec(t || '');
    if (!m) return '';
    var h = +m[1], ap = h < 12 ? 'AM' : 'PM';
    h = h % 12 || 12;
    return h + ':' + m[2] + ' ' + ap;
  }

  // "9:00 AM", "9 am", "21:30", "noon" -> "09:00" ('' if unreadable)
  function to24(s) {
    s = String(s || '').trim().toLowerCase().replace(/\./g, '');
    if (s === 'noon') return '12:00';
    if (s === 'midnight') return '00:00';
    var m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(s);
    if (!m) return '';
    var h = +m[1], mi = m[2] ? +m[2] : 0;
    if (m[3] === 'pm' && h < 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
    if (h > 23 || mi > 59) return '';
    return pad(h) + ':' + pad(mi);
  }

  function dayIndex(s) {
    s = String(s || '').trim().toLowerCase();
    if (LONG[s] != null) return LONG[s];
    for (var k in LONG) if (k.slice(0, 3) === s.slice(0, 3) && s.length >= 3) return LONG[k];
    return -1;
  }

  function blankWeek() {
    return DAYS.map(function () { return { open: false, allDay: false, slots: [['09:00', '20:00']] }; });
  }

  // Text -> week, or null when the text is not in the picker's own shape.
  function parse(text) {
    var lines = String(text || '').split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
    if (!lines.length) return null;
    var week = blankWeek(), seen = 0;
    for (var i = 0; i < lines.length; i++) {
      var m = /^([A-Za-z]+)(?:\s*[–—-]\s*([A-Za-z]+))?\s*:\s*(.+)$/.exec(lines[i]);
      if (!m) return null;
      var a = dayIndex(m[1]), b = m[2] ? dayIndex(m[2]) : a;
      if (a < 0 || b < 0 || b < a) return null;
      var body = m[3].trim(), day;
      if (/^closed$/i.test(body)) day = { open: false, allDay: false, slots: [['09:00', '20:00']] };
      else if (/^open 24 hours$|^24 hours$/i.test(body)) day = { open: true, allDay: true, slots: [['09:00', '20:00']] };
      else {
        var slots = [];
        var parts = body.split(/\s*,\s*/);
        for (var p = 0; p < parts.length; p++) {
          var r = parts[p].split(/\s*[–—]\s*|\s+-\s+|\s+to\s+/i);
          if (r.length !== 2) return null;
          var f = to24(r[0]), t = to24(r[1]);
          if (!f || !t) return null;
          slots.push([f, t]);
        }
        if (!slots.length || slots.length > 2) return null;
        day = { open: true, allDay: false, slots: slots };
      }
      for (var d = a; d <= b; d++) { week[d] = JSON.parse(JSON.stringify(day)); seen++; }
    }
    return seen ? week : null;
  }

  function dayText(d) {
    if (!d.open) return 'Closed';
    if (d.allDay) return 'Open 24 hours';
    return d.slots.map(function (s) { return to12(s[0]) + ' – ' + to12(s[1]); }).join(', ');
  }

  // Week -> text, consecutive days with the same hours folded into one line.
  function format(week) {
    if (week.every(function (d) { return !d.open; })) return '';
    var out = [], i = 0;
    while (i < 7) {
      var t = dayText(week[i]), j = i;
      while (j + 1 < 7 && dayText(week[j + 1]) === t) j++;
      out.push((i === j ? DAYS[i] : DAYS[i] + ' – ' + DAYS[j]) + ': ' + t);
      i = j + 1;
    }
    return out.join('\n');
  }

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function enhance(field) {
    if (field._hr) return;
    var st = { week: parse(field.value) || blankWeek(), dirty: false, legacy: '' };
    field._hr = st;
    if (field.value.trim() && !parse(field.value)) st.legacy = field.value.trim();

    var box = el('div', 'hr-box');
    box.setAttribute('role', 'group');
    var lab = field.id && document.querySelector('label[for="' + field.id + '"]');
    if (lab) { lab.id = lab.id || field.id + 'Label'; box.setAttribute('aria-labelledby', lab.id); lab.removeAttribute('for'); }
    field.parentNode.insertBefore(box, field);
    field.style.display = 'none';
    field.setAttribute('aria-hidden', 'true');
    field.tabIndex = -1;

    var note = el('div', 'hr-note');
    var presets = el('div', 'hr-presets');
    var rows = el('div');
    var preview = el('div', 'hr-preview');
    box.appendChild(note); box.appendChild(presets); box.appendChild(rows); box.appendChild(preview);

    [
      ['Mon – Sat, 9 AM – 8 PM', function (w) { w.forEach(function (d, i) { d.open = i < 6; d.allDay = false; d.slots = [['09:00', '20:00']]; }); }],
      ['Every day, 10 AM – 9 PM', function (w) { w.forEach(function (d) { d.open = true; d.allDay = false; d.slots = [['10:00', '21:00']]; }); }],
      ['Open 24×7', function (w) { w.forEach(function (d) { d.open = true; d.allDay = true; }); }],
      ['Copy Monday to all days', function (w) { var m = JSON.stringify(w[0]); for (var i = 1; i < 7; i++) w[i] = JSON.parse(m); }],
    ].forEach(function (p) {
      var b = el('button', null, p[0]);
      b.type = 'button';
      b.addEventListener('click', function () { p[1](st.week); changed(); });
      presets.appendChild(b);
    });

    function changed() { st.dirty = true; render(); field.value = format(st.week); field.dispatchEvent(new Event('input', { bubbles: true })); }

    function render() {
      note.hidden = !(st.legacy && !st.dirty);
      note.textContent = 'Saved hours: ' + st.legacy + '\nPick the days and times below to replace them.';
      rows.innerHTML = '';
      st.week.forEach(function (d, i) {
        var row = el('div', 'hr-row');
        var dayLab = el('label', 'hr-day');
        var cb = el('input'); cb.type = 'checkbox'; cb.checked = d.open;
        cb.setAttribute('aria-label', 'Open on ' + DAYS[i]);
        cb.addEventListener('change', function () { d.open = cb.checked; changed(); });
        dayLab.appendChild(cb); dayLab.appendChild(document.createTextNode(DAYS[i]));
        row.appendChild(dayLab);

        var slots = el('div', 'hr-slots');
        if (!d.open) slots.appendChild(el('span', 'hr-closed', 'Closed'));
        else {
          if (!d.allDay) d.slots.forEach(function (s, k) {
            var slot = el('div', 'hr-slot');
            var from = el('input'); from.type = 'time'; from.step = 900; from.value = s[0];
            var to = el('input'); to.type = 'time'; to.step = 900; to.value = s[1];
            from.setAttribute('aria-label', DAYS[i] + ' opens' + (k ? ' (after break)' : ''));
            to.setAttribute('aria-label', DAYS[i] + ' closes' + (k ? ' (after break)' : ''));
            from.addEventListener('change', function () { if (from.value) { s[0] = from.value; changed(); } });
            to.addEventListener('change', function () { if (to.value) { s[1] = to.value; changed(); } });
            slot.appendChild(from); slot.appendChild(el('span', null, 'to')); slot.appendChild(to);
            if (k) {
              var x = el('button', 'hr-link hr-x', '×'); x.type = 'button';
              x.setAttribute('aria-label', 'Remove second time slot on ' + DAYS[i]);
              x.addEventListener('click', function () { d.slots.splice(k, 1); changed(); });
              slot.appendChild(x);
            }
            slots.appendChild(slot);
          });
          if (!d.allDay && d.slots.length < 2) {
            var add = el('button', 'hr-link', '+ Add break'); add.type = 'button';
            add.title = 'Split the day into two time slots, e.g. a lunch break';
            add.addEventListener('click', function () {
              var end = d.slots[0][1];
              d.slots[0][1] = '13:00';
              d.slots.push(['16:00', end > '16:00' ? end : '20:00']);
              changed();
            });
            slots.appendChild(add);
          }
          var allLab = el('label', 'hr-24');
          var all = el('input'); all.type = 'checkbox'; all.checked = d.allDay;
          all.addEventListener('change', function () { d.allDay = all.checked; changed(); });
          allLab.appendChild(all); allLab.appendChild(document.createTextNode('24 hours'));
          slots.appendChild(allLab);
        }
        row.appendChild(slots);
        rows.appendChild(row);
      });
      var txt = st.dirty || !st.legacy ? format(st.week) : '';
      preview.textContent = txt ? 'Shown on your listing:\n' + txt : (st.legacy ? '' : 'Tick the days you are open.');
    }

    st.render = render;
    render();
  }

  // Re-read the hidden field after a script filled it (edit dialogs).
  function refresh(field) {
    if (!field._hr) return enhance(field);
    var st = field._hr;
    var w = parse(field.value);
    st.week = w || blankWeek();
    st.legacy = field.value.trim() && !w ? field.value.trim() : '';
    st.dirty = false;
    st.render();
  }

  function scan(root) {
    (root && root.querySelectorAll ? root : document).querySelectorAll('[data-hours]').forEach(enhance);
  }

  window.HoursField = { enhance: enhance, refresh: refresh, parse: parse, format: format, scan: scan };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { scan(document); });
  else scan(document);
})();
