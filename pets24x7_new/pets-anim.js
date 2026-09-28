/* Pet parade: a dog walking, a cat strolling the other way and a puppy chasing
   a ball, drawn in SVG, across a strip just above the footer of every public
   page. Decoration only: hidden from screen readers, never clickable, paused
   while off screen, standing still for reduced-motion users. */
(function () {
  'use strict';
  if (window.__p24Parade) return;
  window.__p24Parade = true;
  if (/^\/dashboard\//.test(location.pathname)) return;

  function dog(c) {
    return '<svg viewBox="0 0 120 76" aria-hidden="true" focusable="false">' +
      '<rect class="pa-leg" x="26" y="46" width="8" height="24" rx="4" fill="' + c.dark + '"/>' +
      '<rect class="pa-leg b" x="66" y="46" width="8" height="24" rx="4" fill="' + c.dark + '"/>' +
      '<g class="pa-bob">' +
        '<path class="pa-tail" d="M24 40 q-14 -4 -18 -18" stroke="' + c.mid + '" stroke-width="6" stroke-linecap="round" fill="none"/>' +
        '<ellipse cx="52" cy="44" rx="30" ry="15" fill="' + c.body + '"/>' +
        (c.patch ? '<ellipse cx="44" cy="40" rx="11" ry="8" fill="' + c.patch + '"/>' : '') +
        '<ellipse cx="78" cy="36" rx="10" ry="9" fill="' + c.body + '"/>' +
        '<circle cx="88" cy="28" r="14" fill="' + c.body + '"/>' +
        '<ellipse cx="84" cy="27" rx="5.5" ry="10" fill="' + c.ear + '" transform="rotate(12 84 27)"/>' +
        '<ellipse cx="100" cy="33" rx="8" ry="6" fill="' + c.snout + '"/>' +
        '<circle cx="107" cy="31" r="3" fill="#1F2937"/>' +
        '<circle class="pa-eye" cx="93" cy="24" r="2.2" fill="#1F2937"/>' +
        '<path d="M100 38 q3 2 6 0" stroke="#1F2937" stroke-width="1.5" fill="none" stroke-linecap="round"/>' +
        '<path d="M78 39 q7 6 15 1" stroke="' + c.collar + '" stroke-width="4" fill="none" stroke-linecap="round"/>' +
      '</g>' +
      '<rect class="pa-leg b" x="36" y="46" width="8" height="24" rx="4" fill="' + c.mid + '"/>' +
      '<rect class="pa-leg" x="76" y="46" width="8" height="24" rx="4" fill="' + c.mid + '"/>' +
      '</svg>';
  }
  var CAT = '<svg viewBox="0 0 110 70" aria-hidden="true" focusable="false">' +
    '<rect class="pa-leg" x="24" y="40" width="7" height="24" rx="3.5" fill="#64748B"/>' +
    '<rect class="pa-leg b" x="62" y="40" width="7" height="24" rx="3.5" fill="#64748B"/>' +
    '<g class="pa-bob">' +
      '<path class="pa-ctail" d="M20 34 q-16 -2 -14 -22 q1 -6 6 -6" stroke="#64748B" stroke-width="5" fill="none" stroke-linecap="round"/>' +
      '<ellipse cx="46" cy="38" rx="28" ry="12" fill="#94A3B8"/>' +
      '<path d="M36 27 q3 5 0 10 M46 26 q3 6 0 12 M56 27 q3 5 0 10" stroke="#64748B" stroke-width="2.5" fill="none" stroke-linecap="round"/>' +
      '<ellipse cx="70" cy="32" rx="8" ry="8" fill="#94A3B8"/>' +
      '<path d="M71 20 l2 -13 l8 8 z M83 17 l6 -11 l3 13 z" fill="#94A3B8"/>' +
      '<path d="M74 17 l1 -6 l4 4 z" fill="#FBCFE8"/>' +
      '<circle cx="80" cy="26" r="12" fill="#94A3B8"/>' +
      '<ellipse class="pa-eye" cx="85" cy="24" rx="2" ry="2.6" fill="#16A34A"/>' +
      '<path d="M91 28 l2.5 1.5 l-2.5 1.5 z" fill="#F472B6"/>' +
      '<path d="M89 31 l11 -2 M89 32.5 l11 2" stroke="#475569" stroke-width="1" stroke-linecap="round"/>' +
    '</g>' +
    '<rect class="pa-leg b" x="32" y="40" width="7" height="24" rx="3.5" fill="#94A3B8"/>' +
    '<rect class="pa-leg" x="70" y="40" width="7" height="24" rx="3.5" fill="#94A3B8"/>' +
    '</svg>';

  var css = document.createElement('style');
  css.textContent =
    '.p24-parade{position:relative;height:88px;overflow:hidden;pointer-events:none;user-select:none;background:transparent}' +
    '.p24-parade{width:100%;flex:0 0 auto;align-self:stretch}' +
    '.p24-parade.pa-fixed{position:fixed;left:0;right:0;bottom:0;width:auto;z-index:0}' +
    '.p24-parade .pa-ground{position:absolute;left:0;right:0;bottom:10px;border-top:2px dashed rgba(148,163,184,.45)}' +
    '.p24-parade .pa-pet{position:absolute;bottom:11px;left:0;will-change:transform;animation:paAcross var(--dur,24s) linear infinite;animation-delay:var(--delay,0s)}' +
    '.p24-parade .pa-pet.back{animation-name:paBack}' +
    '.p24-parade .pa-pet.run{animation-name:paRun}' +
    '.p24-parade .pa-pet.back .pa-flip{transform:scaleX(-1)}' +
    '.p24-parade .pa-pet svg{display:block;width:var(--size,84px);height:auto;overflow:visible}' +
    '.p24-parade .pa-pet svg.pa-heart{width:12px;height:12px}' +
    '.p24-parade .pa-leg{transform-box:fill-box;transform-origin:50% 12%;animation:paLeg var(--step,.6s) ease-in-out infinite}' +
    '.p24-parade .pa-leg.b{animation-delay:calc(var(--step,.6s) / -2)}' +
    '.p24-parade .pa-bob{animation:paBob calc(var(--step,.6s) / 2) ease-in-out infinite alternate}' +
    '.p24-parade .pa-tail{transform-box:fill-box;transform-origin:100% 100%;animation:paWag .35s ease-in-out infinite alternate}' +
    '.p24-parade .pa-ctail{transform-box:fill-box;transform-origin:100% 100%;animation:paSway 1.6s ease-in-out infinite alternate}' +
    '.p24-parade .pa-eye{transform-box:fill-box;transform-origin:50% 50%;animation:paBlink 4.5s infinite}' +
    '.p24-parade .pa-ball{position:absolute;left:calc(var(--size,84px) + 18px);bottom:0;width:14px;height:14px;border-radius:50%;' +
      'background:radial-gradient(circle at 35% 35%,#FCA5A5,#EF4444 60%,#B91C1C);animation:paBounce .38s ease-in infinite alternate}' +
    '.p24-parade .pa-heart{position:absolute;left:50%;top:-6px;width:12px;height:12px;opacity:0;animation:paHeart 3s ease-out infinite}' +
    '@keyframes paAcross{from{transform:translateX(-140px)}to{transform:translateX(var(--w,1400px))}}' +
    '@keyframes paBack{from{transform:translateX(var(--w,1400px))}to{transform:translateX(-140px)}}' +
    '@keyframes paRun{0%{transform:translateX(-160px)}55%,100%{transform:translateX(var(--w,1400px))}}' +
    '@keyframes paLeg{0%,100%{transform:rotate(24deg)}50%{transform:rotate(-24deg)}}' +
    '@keyframes paBob{from{transform:translateY(0)}to{transform:translateY(-2.5px)}}' +
    '@keyframes paWag{from{transform:rotate(-16deg)}to{transform:rotate(18deg)}}' +
    '@keyframes paSway{from{transform:rotate(-6deg)}to{transform:rotate(8deg)}}' +
    '@keyframes paBlink{0%,94%,100%{transform:scaleY(1)}97%{transform:scaleY(.1)}}' +
    '@keyframes paBounce{from{transform:translateY(-26px)}to{transform:translateY(0)}}' +
    '@keyframes paHeart{0%,60%{opacity:0;transform:translateY(0) scale(.6)}70%{opacity:1}100%{opacity:0;transform:translateY(-22px) scale(1)}}' +
    '.p24-parade.pa-off *{animation-play-state:paused!important}' +
    '@media (max-width:600px){.p24-parade{height:72px}.p24-parade .pa-pet{--size:64px}}' +
    '@media (prefers-reduced-motion:reduce){.p24-parade *{animation:none!important}' +
      '.p24-parade .pa-pet.d{transform:translateX(8vw)!important}.p24-parade .pa-pet.back{transform:translateX(62vw)!important}' +
      '.p24-parade .pa-pet.run{transform:translateX(34vw)!important}.p24-parade .pa-heart{display:none}}';
  (document.head || document.documentElement).appendChild(css);

  var HEART = '<svg class="pa-heart" viewBox="0 0 20 18" aria-hidden="true"><path d="M0 5C0-1 8-2 10 4c2-6 10-5 10 1 0 7-10 12-10 12S0 12 0 5z" fill="#FB7185"/></svg>';

  function build() {
    if (document.querySelector('.p24-parade')) return;
    var strip = document.createElement('div');
    strip.className = 'p24-parade';
    strip.setAttribute('aria-hidden', 'true');
    strip.innerHTML =
      '<div class="pa-ground"></div>' +
      // a golden dog on a relaxed walk
      '<div class="pa-pet d" style="--speed:70;--step:.62s;--size:84px">' + HEART + dog({ body: '#F59E0B', mid: '#D97706', dark: '#B45309', ear: '#B45309', snout: '#FDE68A', collar: '#EF4444' }) + '</div>' +
      // a grey cat strolling the other way
      '<div class="pa-pet back" style="--speed:48;--step:.8s;--size:76px"><div class="pa-flip">' + CAT + '</div></div>' +
      // a white puppy sprinting after its ball
      '<div class="pa-pet run" style="--speed:200;--step:.3s;--size:62px"><span class="pa-ball"></span>' + dog({ body: '#F8FAFC', mid: '#E2E8F0', dark: '#CBD5E1', ear: '#92400E', snout: '#FFFFFF', collar: '#2563EB', patch: '#FDE68A' }) + '</div>';

    var foot = document.querySelector('body > footer, footer.site-footer, footer');
    var bs = window.getComputedStyle(document.body);
    if (foot && foot.parentNode) foot.parentNode.insertBefore(strip, foot);
    else if (/flex/.test(bs.display) && bs.flexDirection.indexOf('column') !== 0) {
      // Small centred pages (404, reset, thank-you) lay the body out as a row:
      // pin the strip to the bottom edge and keep room for it under the card.
      strip.classList.add('pa-fixed');
      document.body.appendChild(strip);
      document.body.style.paddingBottom = 'max(' + (bs.paddingBottom || '0px') + ', 96px)';
    } else document.body.appendChild(strip);

    // Speed stays the same on a phone and a wide screen: duration = distance / speed.
    function size() {
      var w = strip.clientWidth + 40;
      strip.style.setProperty('--w', w + 'px');
      [].forEach.call(strip.querySelectorAll('.pa-pet'), function (p, i) {
        var sp = parseFloat(p.style.getPropertyValue('--speed')) || 60;
        var dist = w + 160;
        var dur = dist / sp;
        if (p.classList.contains('run')) dur = dur / 0.55 + 4; // run takes 55% of the loop, then a pause
        p.style.setProperty('--dur', dur.toFixed(1) + 's');
        // start them spread out, not all at the left edge
        p.style.setProperty('--delay', (-dur * [0.15, 0.55, 0.9][i]).toFixed(1) + 's');
      });
    }
    size();
    var t;
    window.addEventListener('resize', function () { clearTimeout(t); t = setTimeout(size, 200); });

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (es) {
        es.forEach(function (e) { strip.classList.toggle('pa-off', !e.isIntersecting); });
      }).observe(strip);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})();
