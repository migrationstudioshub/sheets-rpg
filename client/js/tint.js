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
    hair_white:  ['#6e6865', '#a39c97', '#cfc8c0', '#ece6dc']
  };

  function hex(h) { return [1, 3, 5].map(function (i) { return parseInt(h.slice(i, i + 2), 16); }); }
  var cache = {};   // key: image src + ramp -> composed canvas (built once)

  /** Returns a canvas of `img` with its `maskImg` cloth recoloured by `ramp` (4 hex colours).
   *  Falls back to the plain image when there is no mask or ramp (or the mask isn't loaded). */
  function getTintedLayer(img, maskImg, ramp) {
    if (!img || !maskImg || !ramp) return img;
    var key = (img.src || '') + '|' + ramp.join();
    if (cache[key]) return cache[key];

    var c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
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
    ctx.drawImage(img, 0, 0);
    return (cache[key] = c);
  }

  return { TINTS: TINTS, getTintedLayer: getTintedLayer };
})();
if (typeof module !== 'undefined') module.exports = Tint;
