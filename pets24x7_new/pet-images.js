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
    'veterinary-clinics': ['photo-1628009368231-7bb7cfcb0def','photo-1583337130417-3346a1be7dee','photo-1581888227599-779811939961','photo-1606851094291-6efae152bb87','photo-1535930891776-0c2dfb7fda1a'],
    'emergency-animal-hospital': ['photo-1583337130417-3346a1be7dee','photo-1628009368231-7bb7cfcb0def','photo-1606851094291-6efae152bb87','photo-1535930891776-0c2dfb7fda1a','photo-1601758125946-6ec2ef64daf8'],
    'vaccination-centers': ['photo-1606851094291-6efae152bb87','photo-1581888227599-779811939961','photo-1628009368231-7bb7cfcb0def','photo-1583337130417-3346a1be7dee','photo-1574144611937-0df059b5ef3e'],
    'mobile-vet-services': ['photo-1601758228041-f3b2795255f1','photo-1535930891776-0c2dfb7fda1a','photo-1450778869180-41d0601e046e','photo-1601758003122-53c40e686a19','photo-1520087619250-584c0cbd35e8'],
    'specialty-vets-exotics-avian-reptiles': ['photo-1452857297128-d9c29adba80b','photo-1574144611937-0df059b5ef3e','photo-1441057206919-63d19fac2369','photo-1535930891776-0c2dfb7fda1a','photo-1583337130417-3346a1be7dee'],
    'veterinary-labs-diagnostics': ['photo-1581093588401-fbb62a02f120','photo-1559190394-df5a28aab5c5','photo-1574144611937-0df059b5ef3e','photo-1606851094291-6efae152bb87','photo-1583337130417-3346a1be7dee'],
    'pet-dental-care': ['photo-1548199973-03cce0bbc87b','photo-1601758125946-6ec2ef64daf8','photo-1543466835-00a7907e9de1','photo-1583512603805-3cc6b41f3edb','photo-1552053831-71594a27632d'],
    'pet-physiotherapy-rehab': ['photo-1576201836106-db1758fd1c97','photo-1450778869180-41d0601e046e','photo-1601758003122-53c40e686a19','photo-1518020382113-a7e8fc38eac9','photo-1543466835-00a7907e9de1'],
    'pet-grooming-spa': ['photo-1516734212186-a967f81ad0d7','photo-1591768793355-74d04bb6608f','photo-1548767797-d8c844163c4c','photo-1560807707-8cc77767d783','photo-1583512603805-3cc6b41f3edb'],
    'pet-boarding-daycare': ['photo-1543466835-00a7907e9de1','photo-1477884213360-7e9d7dcc1e48','photo-1596492784531-6e6eb5ea9993','photo-1507146426996-ef05306b995a','photo-1444212477490-ca407925329e'],
    'pet-walking': ['photo-1450778869180-41d0601e046e','photo-1518020382113-a7e8fc38eac9','photo-1601758003122-53c40e686a19','photo-1441057206919-63d19fac2369','photo-1552053831-71594a27632d'],
    'pet-training-obedience-behavior': ['photo-1587300003388-59208cc962cb','photo-1551717743-49959800b1f6','photo-1552053831-71594a27632d','photo-1518020382113-a7e8fc38eac9','photo-1594149929911-78975a43d4f5'],
    'pet-sitting-in-home-care': ['photo-1596492784531-6e6eb5ea9993','photo-1507146426996-ef05306b995a','photo-1522276498395-f4f68f7f8454','photo-1560807707-8cc77767d783','photo-1477884213360-7e9d7dcc1e48'],
    'pet-relocation-services': ['photo-1518717758536-85ae29035b6d','photo-1425082661705-1834bfd09dca','photo-1520087619250-584c0cbd35e8','photo-1601758003122-53c40e686a19','photo-1441057206919-63d19fac2369'],
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

  window.PetImages = { POOL: POOL, categoryImg: categoryImg, cardImg: cardImg, imgFor: imgFor };
})();
