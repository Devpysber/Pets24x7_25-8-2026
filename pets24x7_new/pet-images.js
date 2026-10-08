/**
 * Pets24x7 — category photo pools.
 *
 * Google listing data carries no usable photo, so each business shows a
 * representative pet photo for its category. One photo per category made every
 * card on a page identical; each category now has a pool and the photo is
 * chosen by a stable hash of the listing id, so a page looks varied and a given
 * business always keeps the same picture.
 *
 * Every id below was checked against images.unsplash.com and returns 200.
 * A vendor's own uploaded photo always wins over these.
 */
(function () {
  var POOL = {
    'veterinary-clinics': ['photo-1628009368231-7bb7cfcb0def','photo-1583337130417-3346a1be7dee','photo-1581888227599-779811939961','photo-1543466835-00a7907e9de1','photo-1535930891776-0c2dfb7fda1a'],
    'emergency-animal-hospital': ['photo-1583337130417-3346a1be7dee','photo-1628009368231-7bb7cfcb0def','photo-1543466835-00a7907e9de1','photo-1535930891776-0c2dfb7fda1a','photo-1543466835-00a7907e9de1'],
    'vaccination-centers': ['photo-1543466835-00a7907e9de1','photo-1581888227599-779811939961','photo-1628009368231-7bb7cfcb0def','photo-1583337130417-3346a1be7dee','photo-1574144611937-0df059b5ef3e'],
    'mobile-vet-services': ['photo-1543466835-00a7907e9de1','photo-1535930891776-0c2dfb7fda1a','photo-1450778869180-41d0601e046e','photo-1601758003122-53c40e686a19','photo-1520087619250-584c0cbd35e8'],
    'specialty-vets-exotics-avian-reptiles': ['photo-1452857297128-d9c29adba80b','photo-1574144611937-0df059b5ef3e','photo-1543466835-00a7907e9de1','photo-1535930891776-0c2dfb7fda1a','photo-1583337130417-3346a1be7dee'],
    'veterinary-labs-diagnostics': ['photo-1543466835-00a7907e9de1','photo-1559190394-df5a28aab5c5','photo-1574144611937-0df059b5ef3e','photo-1543466835-00a7907e9de1','photo-1583337130417-3346a1be7dee'],
    'pet-dental-care': ['photo-1548199973-03cce0bbc87b','photo-1543466835-00a7907e9de1','photo-1543466835-00a7907e9de1','photo-1583512603805-3cc6b41f3edb','photo-1552053831-71594a27632d'],
    'pet-physiotherapy-rehab': ['photo-1576201836106-db1758fd1c97','photo-1450778869180-41d0601e046e','photo-1601758003122-53c40e686a19','photo-1518020382113-a7e8fc38eac9','photo-1543466835-00a7907e9de1'],
    'pet-grooming-spa': ['photo-1516734212186-a967f81ad0d7','photo-1596492784531-6e6eb5ea9993','photo-1548767797-d8c844163c4c','photo-1560807707-8cc77767d783','photo-1583512603805-3cc6b41f3edb'],
    'pet-boarding-daycare': ['photo-1543466835-00a7907e9de1','photo-1477884213360-7e9d7dcc1e48','photo-1596492784531-6e6eb5ea9993','photo-1507146426996-ef05306b995a','photo-1444212477490-ca407925329e'],
    'pet-walking': ['photo-1450778869180-41d0601e046e','photo-1518020382113-a7e8fc38eac9','photo-1601758003122-53c40e686a19','photo-1543466835-00a7907e9de1','photo-1552053831-71594a27632d'],
    'pet-training-obedience-behavior': ['photo-1587300003388-59208cc962cb','photo-1551717743-49959800b1f6','photo-1552053831-71594a27632d','photo-1518020382113-a7e8fc38eac9','photo-1594149929911-78975a43d4f5'],
    'pet-sitting-in-home-care': ['photo-1596492784531-6e6eb5ea9993','photo-1507146426996-ef05306b995a','photo-1522276498395-f4f68f7f8454','photo-1560807707-8cc77767d783','photo-1477884213360-7e9d7dcc1e48'],
    'pet-relocation-services': ['photo-1518717758536-85ae29035b6d','photo-1425082661705-1834bfd09dca','photo-1520087619250-584c0cbd35e8','photo-1601758003122-53c40e686a19','photo-1543466835-00a7907e9de1'],
    'pet-taxi-transport': ['photo-1425082661705-1834bfd09dca','photo-1518717758536-85ae29035b6d','photo-1520087619250-584c0cbd35e8','photo-1450778869180-41d0601e046e','photo-1601758003122-53c40e686a19'],
    'pet-therapy-services': ['photo-1541599540903-216a46ca1dc0','photo-1522276498395-f4f68f7f8454','photo-1594149929911-78975a43d4f5','photo-1507146426996-ef05306b995a','photo-1551717743-49959800b1f6']
  };

  var FALLBACK = ['photo-1583337130417-3346a1be7dee','photo-1477884213360-7e9d7dcc1e48','photo-1444212477490-ca407925329e','photo-1552053831-71594a27632d','photo-1507146426996-ef05306b995a'];

  // djb2 — small, stable, and enough to spread ids across a 5-photo pool.
  function hash(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    return h;
  }

  function slugOf(b) {
    if (!b) return '';
    if (b.category_slug) return b.category_slug;
    // Fall back to slugifying the display category when the data has no slug.
    return String(b.category || '').toLowerCase()
      .replace(/[(),]/g, '')
      .replace(/&/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /** Representative photo URL for a listing, at the requested box size. */
  function categoryImg(b, w, h) {
    var pool = POOL[slugOf(b)] || FALLBACK;
    var key = String((b && (b.id || b.name)) || '');
    var id = pool[hash(key) % pool.length];
    return 'https://images.unsplash.com/' + id + '?w=' + (w || 560) + '&h=' + (h || 420) + '&fit=crop&q=70';
  }

  /** Vendor upload wins; otherwise the category photo. */
  function cardImg(b, w, h) {
    if (b && b.imageUrl) return b.imageUrl;
    return categoryImg(b, w, h);
  }

  /**
   * Nth photo for a listing — used by the listing-page gallery so its four
   * frames differ while staying stable for that business.
   */
  function imgFor(b, idx, w, h) {
    var pool = POOL[slugOf(b)] || FALLBACK;
    var key = String((b && (b.id || b.name)) || '');
    var id = pool[(hash(key) + (idx || 0)) % pool.length];
    return 'https://images.unsplash.com/' + id + '?w=' + (w || 1000) + '&h=' + (h || 700) + '&fit=crop&q=75';
  }

  // ---- Card visual: the business's own photo, else a monogram tile ----
  // Stock photos on cards repeated down every long page (five per category)
  // and showed animals the business never saw. Cards now show the business's
  // own photo when it has one, and otherwise its category icon and initials in
  // the category colour. A photo that fails to load falls back to the tile.
  var TINT = {
    'veterinary-clinics': ['#DBEAFE', '#1D4ED8'], 'emergency-animal-hospital': ['#FEE2E2', '#B91C1C'],
    'vaccination-centers': ['#E0F2FE', '#0369A1'], 'mobile-vet-services': ['#E0E7FF', '#4338CA'],
    'specialty-vets-exotics-avian-reptiles': ['#DCFCE7', '#15803D'], 'veterinary-labs-diagnostics': ['#F1F5F9', '#334155'],
    'pet-dental-care': ['#F0F9FF', '#0E7490'], 'pet-physiotherapy-rehab': ['#ECFDF5', '#047857'],
    'pet-grooming-spa': ['#FCE7F3', '#BE185D'], 'pet-boarding-daycare': ['#FEF3C7', '#B45309'],
    'pet-walking': ['#ECFCCB', '#4D7C0F'], 'pet-training-obedience-behavior': ['#FFEDD5', '#C2410C'],
    'pet-sitting-in-home-care': ['#F3E8FF', '#7E22CE'], 'pet-relocation-services': ['#E0F2FE', '#075985'],
    'pet-taxi-transport': ['#FEF9C3', '#A16207'], 'pet-therapy-services': ['#FFE4E6', '#BE123C'],
    'pet-store': ['#E0E7FF', '#3730A3']
  };
  function esc(x) {
    return String(x == null ? '' : x).replace(/[<>&"']/g, function (c) {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function initials(name) {
    var w = String(name || '').split(/[^A-Za-z0-9]+/).filter(Boolean);
    return ((w[0] || 'P').charAt(0) + (w[1] ? w[1].charAt(0) : '')).toUpperCase();
  }
  function monoTile(b) {
    var t = TINT[slugOf(b)] || ['#EEF2FF', '#3730A3'];
    return '<span class="biz-mono" style="--mono-bg:' + t[0] + ';--mono-fg:' + t[1] + '" aria-hidden="true">' +
      '<span class="biz-mono-ico">' + esc((b && (b.category_icon || b.categoryIcon)) || '🐾') + '</span>' +
      '<span class="biz-mono-txt">' + esc(initials(b && b.name)) + '</span></span>';
  }
  // Card photos: the category's own photos, then a shared pool of ~30 pet
  // photos, handed out in render order from a per-page start, so neighbouring
  // cards never share a photo. Mirrors card_pool()/card_img() in build_pages.py.
  var GENERIC = ['photo-1543466835-00a7907e9de1', 'photo-1507146426996-ef05306b995a', 'photo-1587300003388-59208cc962cb', 'photo-1583337130417-3346a1be7dee', 'photo-1551717743-49959800b1f6', 'photo-1518020382113-a7e8fc38eac9', 'photo-1596492784531-6e6eb5ea9993', 'photo-1450778869180-41d0601e046e', 'photo-1560807707-8cc77767d783', 'photo-1581888227599-779811939961', 'photo-1535930891776-0c2dfb7fda1a', 'photo-1477884213360-7e9d7dcc1e48', 'photo-1583512603805-3cc6b41f3edb', 'photo-1518717758536-85ae29035b6d', 'photo-1552053831-71594a27632d', 'photo-1522276498395-f4f68f7f8454', 'photo-1444212477490-ca407925329e', 'photo-1574144611937-0df059b5ef3e', 'photo-1541599540903-216a46ca1dc0', 'photo-1516734212186-a967f81ad0d7', 'photo-1594149929911-78975a43d4f5', 'photo-1601758003122-53c40e686a19', 'photo-1548199973-03cce0bbc87b', 'photo-1559190394-df5a28aab5c5', 'photo-1576201836106-db1758fd1c97', 'photo-1520087619250-584c0cbd35e8', 'photo-1628009368231-7bb7cfcb0def'];
  var EXOTIC = ['photo-1425082661705-1834bfd09dca', 'photo-1452857297128-d9c29adba80b', 'photo-1548767797-d8c844163c4c'];
  function cardPool(b) {
    var slug = slugOf(b), out = [];
    var all = (POOL[slug] || FALLBACK).concat(slug === 'specialty-vets-exotics-avian-reptiles' ? EXOTIC : [], GENERIC);
    for (var i = 0; i < all.length; i++) if (out.indexOf(all[i]) < 0) out.push(all[i]);
    return out;
  }
  var autoIdx = 0, usedIds = {};
  function cardImgAt(b, idx, seed, w, h) {
    var pool = cardPool(b);
    var start = hash(String(seed == null ? location.pathname : seed)) + idx, id = pool[start % pool.length];
    // Skip photos this page already shows (cards of different categories draw
    // from different pools and could otherwise land on the same one).
    for (var k = 0; k < pool.length && usedIds[id]; k++) id = pool[(start + k + 1) % pool.length];
    usedIds[id] = 1;
    if (Object.keys(usedIds).length >= GENERIC.length) usedIds = {};
    return 'https://images.unsplash.com/' + id + '?w=' + (w || 240) + '&h=' + (h || 240) + '&fit=crop&crop=faces,entropy&q=70';
  }
  /** Card art HTML (place inside a position:relative box). */
  /** w/h: the box's shape in pixels (wide banners want a wide crop); default a 240px square. */
  function cardVisual(b, idx, seed, w, h) {
    if (idx == null) idx = autoIdx++;
    var src = (b && b.imageUrl) || cardImgAt(b, idx, seed, w, h);
    return '<img class="biz-own" loading="lazy" src="' + esc(src) + '" alt="" onerror="this.remove()">' + monoTile(b);
  }
  var css = document.createElement('style');
  css.textContent =
    '.biz-mono{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;' +
    'background:var(--mono-bg,#EEF2FF);color:var(--mono-fg,#3730A3)}' +
    '.biz-mono-ico{font-size:clamp(22px,2.4vw,38px);line-height:1}' +
    '.biz-mono-txt{font-weight:800;font-size:clamp(13px,1.3vw,18px);letter-spacing:.5px;font-family:inherit}' +
    'img.biz-own{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:1}';
  (document.head || document.documentElement).appendChild(css);

  window.PetImages = { POOL: POOL, categoryImg: categoryImg, cardImg: cardImg, imgFor: imgFor, monoTile: monoTile, cardVisual: cardVisual, cardImgAt: cardImgAt };
})();
