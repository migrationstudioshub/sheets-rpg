/**
 * Tintable clothing & hair for the paper-doll renderer (browser only — uses canvas).
 *
 * Convention: a worn sprite `foo.png` may have a sibling mask `foo.tint.png` whose grey
 * values 64/128/192/255 mark shade 0..3 of the recolourable cloth. At draw time the mask is
 * painted with a 4-colour ramp from TINTS and the fixed part (`foo.png`) is drawn over it, so
 * one grey mask + any ramp = any colour of that garment. Hair is the same, with hair_* ramps.
 *
 * Classic script (no modules), to match the rest of shared/ and client/: look nothing up at
 * load time. Exposes window.Tint = { TINTS, getTintedLayer }.
 */
var Tint = (function () {
  var TINTS = {
    black:    ['#141318', '#25232a', '#38353d', '#524e56'],
    charcoal: ['#2c2a31', '#423f46', '#5e5a60', '#837d7f'],
    navy:     ['#161c2a', '#1e2532', '#333f58', '#536884'],
    olive:    ['#272a1f', '#3e4331', '#5d6447', '#7c8862'],
    khaki:    ['#4a4230', '#6b5f43', '#8f805a', '#b3a276'],
    brown:    ['#38251a', '#5b3923', '#88582f', '#b0793b'],
    maroon:   ['#2d090c', '#5a1118', '#8e1c22', '#c1352d'],
    bone:     ['#6c6058', '#ada59f', '#d8cfc2', '#e7ddc2'],
    hazard:   ['#4d3d12', '#7d6418', '#c49b2a', '#dcc05a'],
    // hair colours (chosen at character creation)
    hair_black:  ['#100e12', '#1d1a1f', '#2e2a30', '#46404a'],
    hair_dark:   ['#1e1410', '#33221a', '#4d3426', '#6b4b37'],
    hair_brown:  ['#2e1d13', '#4f321f', '#77502f', '#9c7044'],
    hair_auburn: ['#2e1210', '#5a2219', '#873a22', '#b05a2e'],
    hair_ginger: ['#4a1f0e', '#7d3a15', '#b5601f', '#d98a3a'],
    hair_blonde: ['#5a4526', '#8a6d3b', '#b8975a', '#dcc28a'],
    hair_grey:   ['#3a3739', '#5f5b5c', '#8c8686', '#b9b2ad'],
    hair_white:  ['#6e6865', '#a39c97', '#cfc8c0', '#ece6dc'],
    // liquids (a terrain's `tint`, on the animated water / lava sheets)
    water_teal:  ['#141f21', '#1d3335', '#2a4a4a', '#3f6b66'],
    water_blue:  ['#1c1b21', '#1e2532', '#333f58', '#536884'],
    water_swamp: ['#1a1d14', '#272c1c', '#3a4229', '#58613d'],
    water_toxic: ['#142016', '#1f3a1e', '#2f5a26', '#6b9a2e'],
    water_blood: ['#1a0a0c', '#2d090c', '#5a1118', '#8e1c22'],
    lava:        ['#5a1118', '#8e1c22', '#b0793b', '#c49b2a'],
    lava_blue:   ['#1e2532', '#333f58', '#536884', '#a9c4d6'],
    lava_toxic:  ['#1f3a1e', '#2f5a26', '#6b9a2e', '#c4d65a']
  };

  function hex(h) { return [1, 3, 5].map(function (i) { return parseInt(h.slice(i, i + 2), 16); }); }
  var cache = {};   // key: image src + ramp -> composed canvas (built once)

  /** Returns a canvas of `img` with its `maskImg` cloth recoloured by `ramp` (4 hex colours).
   *  Falls back to the plain image when there is no mask or ramp (or the mask isn't loaded). */
  function getTintedLayer(img, maskImg, ramp) {
    if (!maskImg || !ramp) return img;
    var key = (img ? img.src || '' : 'mask:' + (maskImg.src || '')) + '|' + ramp.join();   // (img missing = a layer that is all mask: see layer)
    if (cache[key]) return cache[key];

    var c = document.createElement('canvas'); c._key = key;
    c.width = (img || maskImg).width; c.height = (img || maskImg).height;
    var ctx = c.getContext('2d');

    // 1. recolour the mask: shade index = round(grey / 64) - 1, clamped to 0..3
    ctx.drawImage(maskImg, 0, 0);
    var d = ctx.getImageData(0, 0, c.width, c.height), cols = ramp.map(hex);
    for (var i = 0; i < d.data.length; i += 4) {
      if (d.data[i + 3] === 0) continue;
      var col = cols[Math.min(3, Math.max(0, Math.round(d.data[i] / 64) - 1))];
      d.data[i] = col[0]; d.data[i + 1] = col[1]; d.data[i + 2] = col[2]; d.data[i + 3] = 255;
    }
    ctx.putImageData(d, 0, 0);

    // 2. fixed (untinted) part on top; the two never overlap
    if (img) ctx.drawImage(img, 0, 0);
    return (cache[key] = c);
  }
  /** What to draw for one paper-doll layer: its picture `foo.png`, with its mask `foo.tint.png` coloured by `ramp`
   *  under it. EITHER may be missing (owner, 27 Nov 2026): a layer that is nothing but colour — stubble, make-up — has
   *  only the mask and still draws; one with no mask or no colour is the plain picture. null = nothing to draw yet.
   *  The one place that decides this: the game, the character screen and the Studio's previews all ask it. */
  function ready(im) { return !!im && im.width > 0 && im.complete !== false; }
  function layer(img, maskImg, ramp) {
    var b = ready(img) ? img : null, m = ramp && ready(maskImg) ? maskImg : null;
    return m ? getTintedLayer(b, m, ramp) : b;
  }

  /** Ground sheets (water, lava): the picture is complete as drawn, in its own colours, and the mask marks what a
   *  tint may recolour. So here the recoloured mask goes ON TOP of the picture (the opposite of clothing); what the
   *  mask leaves out — glints, the lava's crust — keeps its colour. No mask loaded = the picture as it is. */
  function tintedOver(img, maskImg, ramp) {
    if (!img || !maskImg || !ramp) return img;
    var key = 'over|' + (img.src || '') + '|' + ramp.join();
    if (cache[key]) return cache[key];
    var m = document.createElement('canvas'); m.width = img.width; m.height = img.height;
    var mg = m.getContext('2d');
    mg.drawImage(maskImg, 0, 0);
    var d = mg.getImageData(0, 0, m.width, m.height), cols = ramp.map(hex);
    for (var i = 0; i < d.data.length; i += 4) {
      if (d.data[i + 3] === 0) continue;
      var col = cols[Math.min(3, Math.max(0, Math.round(d.data[i] / 64) - 1))];
      d.data[i] = col[0]; d.data[i + 1] = col[1]; d.data[i + 2] = col[2]; d.data[i + 3] = 255;
    }
    mg.putImageData(d, 0, 0);
    var c = document.createElement('canvas'); c._key = key; c.width = img.width; c.height = img.height;
    var g = c.getContext('2d'); g.drawImage(img, 0, 0); g.drawImage(m, 0, 0);
    return (cache[key] = c);
  }

  // ---- skin ----
  // The bodies (and the hands drawn into weapon pictures) are painted in one light skin: three colours, SKIN_ART.
  // A tone recolours them by the same factor per channel, so the shading keeps its steps. On a body every skin-like
  // pixel counts too (warm, saturated: art drawn later in other shades of skin); on anything else only the three
  // exact colours, so leather and wood are left alone.
  var SKINS = { skin_pale: '#ecc9a8', skin_light: '#d6aa83', skin_tan: '#c4935f', skin_olive: '#aa8457',
    skin_brown: '#8f5f3c', skin_dark: '#6b4329', skin_deep: '#4d2f1e' };
  var SKIN_ART = { '214,170,131': 1, '139,90,65': 1, '95,59,44': 1 }, SKIN_BASE = [214, 170, 131];
  function skinLike(r, g, b) {
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (mx < 60 || d / mx < 0.35 || mx !== r) return false;
    var h = 60 * (((g - b) / d) % 6);
    return h >= 10 && h <= 35;
  }
  /** `img` (an image, or a canvas from getTintedLayer) with its skin in the tone named; exactOnly = the three art colours only. */
  function skinned(img, tone, exactOnly) {
    var to = SKINS[tone];
    if (!img || !to || tone === 'skin_light') return img;
    var key = 'skin|' + (img._key || img.src || '') + '|' + tone + (exactOnly ? '|x' : '');
    if (cache[key]) return cache[key];
    var c = document.createElement('canvas'); c._key = key;
    c.width = img.width; c.height = img.height;
    var ctx = c.getContext('2d'), t = hex(to), f = [t[0] / SKIN_BASE[0], t[1] / SKIN_BASE[1], t[2] / SKIN_BASE[2]];
    ctx.drawImage(img, 0, 0);
    var d = ctx.getImageData(0, 0, c.width, c.height), px = d.data;
    for (var i = 0; i < px.length; i += 4) {
      if (px[i + 3] === 0) continue;
      if (!(SKIN_ART[px[i] + ',' + px[i + 1] + ',' + px[i + 2]] || (!exactOnly && skinLike(px[i], px[i + 1], px[i + 2])))) continue;
      px[i] = Math.min(255, Math.round(px[i] * f[0])); px[i + 1] = Math.min(255, Math.round(px[i + 1] * f[1])); px[i + 2] = Math.min(255, Math.round(px[i + 2] * f[2]));
    }
    ctx.putImageData(d, 0, 0);
    return (cache[key] = c);
  }

  // A worn picture whose cloth is all in its mask (hair, clothes, hats, packs) shows nothing of it without a colour. When
  // a look (an NPC's outfit, an appearance set) names no colour for one, it is drawn in this default instead — never half
  // a garment. Weapons and bodies keep their own colours (no default: their masks, if any, stay unused).
  var GARMENT = /^(hair|beard|chest|shirt|jacket|vest|armor|coat|helm|hat|mask|hood|legs|pants|skirt|back|cape|pack|bag)$/;
  function lookTint(path, tint) {
    if (tint) return tint;
    var n = String(path || '').split('/').pop().toLowerCase(), i = n.indexOf('_'), pre = i < 0 ? n : n.slice(0, i);
    if (!/\/paperdoll\//.test(String(path || '')) || !GARMENT.test(pre)) return '';
    return pre === 'hair' || pre === 'beard' ? 'hair_brown' : 'khaki';
  }

  // A look's skin tone (an NPC's outfit, an appearance roll) is the colour given to its body layer, when that is a skin
  // tone (SKINS). Answers {tone, all} for one layer: the body takes the tone on every skin-like pixel, what is held in the
  // hands (paperdoll/hands/) on the three exact skin colours only — as for a player. null = leave the layer as it is.
  // Gear cut for a man and for each build of a woman (owner, 27 Nov 2026): male/ holds the man's picture, and
  // female/curvy/ and female/slim/ the same garment under the same name + _curvy / _slim
  // (paperdoll/chest/male/chest_hoodie.png → …/chest/female/slim/chest_hoodie_slim.png). Content names the man's;
  // twin(path, build) answers where that build's would be ('' = this picture has no such folder, or no build). A
  // woman's body draws the twin when the file is there (Assets.wornFor; the Studio's composeLook), else the picture
  // named. buildOf: a character's body ('female' | 'female_slim') as a build. femaleLook: the build of a look's body,
  // by its picture (…_female.png = 'curvy', …_female_slim.png = 'slim', else '').
  function twin(path, build) {
    var p = String(path || ''), b = build === 'slim' ? 'slim' : (build ? 'curvy' : '');
    return b && /\/male\/[^\/]+\.png$/i.test(p) ? p.replace(/\/male\/([^\/]+)\.png$/i, '/female/' + b + '/$1_' + b + '.png') : '';
  }
  function buildOf(body) { return body === 'female' ? 'curvy' : (body === 'female_slim' ? 'slim' : ''); }
  function femaleLook(look) {
    for (var i = 0; i < (look || []).length; i++) {
      var m = look[i] && /(^|\/)body_[^\/]*_female(_slim)?\.png$/i.exec(String(look[i].path || ''));
      if (m) return m[2] ? 'slim' : 'curvy';
    }
    return '';
  }
  function chestLayer(path) { return isBody(path) || /\/chest\//.test(String(path || '')); }   // the layers of a look a woman's chest moves in
  function isBody(path) { return /(^|\/)body_[^\/]*$/i.test(String(path || '')); }
  function lookSkin(look) {
    for (var i = 0; i < (look || []).length; i++) if (look[i] && isBody(look[i].path) && SKINS[look[i].tint]) return look[i].tint;
    return '';
  }
  function skinFor(path, tone) {
    if (!tone) return null;
    if (isBody(path)) return { tone: tone, all: true };
    return /\/hands\//.test(String(path || '')) ? { tone: tone, all: false } : null;
  }

  return { TINTS: TINTS, SKINS: SKINS, getTintedLayer: getTintedLayer, layer: layer, tintedOver: tintedOver, skinned: skinned, lookTint: lookTint,
    twin: twin, buildOf: buildOf, femaleLook: femaleLook, chestLayer: chestLayer, lookSkin: lookSkin, skinFor: skinFor };
})();
if (typeof module !== 'undefined') module.exports = Tint;
