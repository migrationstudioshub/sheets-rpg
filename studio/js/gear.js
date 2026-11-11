/**
 * Gear maker: a separate editor screen that drives the paper-doll art pipeline to make
 * one piece of gear (or a hairstyle) from a text description, the same way make_gear.py does.
 *
 * It only works against the local gear server (tools/gear_server.py) -- the generation needs
 * Gemini + Python/Pillow/numpy, so it cannot run on GitHub Pages. When the server isn't there,
 * the view explains how to start it instead of showing the form.
 *
 * Classic script (no modules), global `Gear`. Uses the local gear API:
 *   GET  /gear/ping                -> { ok, has_key }
 *   POST /gear/make {slot,name,what,tint?,kind?,keep_hair?,variants?,google_api?}
 *                                  -> { variants:[{fname,slot,layer,tint,review,solid_px,has_mask,hides_hair}] }
 *   POST /gear/save {fname}         -> { saved:[paths] }
 */
var Gear = (function () {
  var KEY_LS = 'sheetsrpg.googleKey';
  // slot id -> label; keys must match make_gear.py SLOTS
  var SLOTS = [
    ['helm', 'Helm / head'], ['armor', 'Armor / torso'], ['back', 'Back'],
    ['weapon', 'Weapon'], ['offhand', 'Off-hand'], ['hair', 'Hair']
  ];
  var CLOTH_TINTS = ['black', 'charcoal', 'navy', 'olive', 'khaki', 'brown', 'maroon', 'bone', 'hazard'];
  var HAIR_TINTS = ['hair_black', 'hair_dark', 'hair_brown', 'hair_auburn', 'hair_ginger', 'hair_blonde', 'hair_grey', 'hair_white'];
  var BODY_SRC = '../art/sprites/paperdoll/body_survivor.png';

  var root = null, fields = null, statusEl = null, outEl = null;
  var bodyImg = null, serverOk = false, hasKey = false;

  function h(tag, props) {
    var el = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === 'style') el.style.cssText = props[k];
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), props[k]);
      else if (k === 'text') el.textContent = props[k];
      else if (k in el && k !== 'list') el[k] = props[k];
      else el.setAttribute(k, props[k]);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null || c === false) continue;
      (Array.isArray(c) ? c : [c]).forEach(function (x) {
        if (x != null && x !== false) el.appendChild(typeof x === 'string' ? document.createTextNode(x) : x);
      });
    }
    return el;
  }

  function field(label, control, hint) {
    return h('div', { className: 'field' }, h('label', { text: label }), control, hint ? h('div', { className: 'note', text: hint }) : null);
  }

  function ensureDom() {
    if (root) return;
    bodyImg = new Image(); bodyImg.src = BODY_SRC;   // for the live tint preview (optional)

    var slot = h('select', { onchange: refreshConditional }, SLOTS.map(function (s) {
      return h('option', { value: s[0], text: s[1] });
    }));
    var name = h('input', { placeholder: 'snake_case id, e.g. trench_coat' });
    var what = h('textarea', { rows: 3, placeholder: 'what it looks like, e.g. "a long dirty trench coat, belted"' });
    var tint = h('input', { placeholder: "which part recolours, e.g. 'the coat fabric, not the buttons'" });
    var kind = h('select', {}, [h('option', { value: 'blade', text: 'melee (sword_)' }), h('option', { value: 'gun', text: 'gun (gun_)' })]);
    var keepHair = h('input', { type: 'checkbox' });
    var variants = h('select', {}, [1, 2, 3].map(function (n) { return h('option', { value: String(n), text: n + (n > 1 ? ' candidates' : ' candidate') }); }));

    fields = { slot: slot, name: name, what: what, tint: tint, kind: kind, keepHair: keepHair, variants: variants };

    var tintField = field('Tintable part (optional)', tint,
      'Leave blank for a fixed-colour item. Fill in to make a recolourable cloth mask.');
    var kindField = field('Weapon type', kind, 'Keeps the existing sword_/gun_ file names.');
    var keepField = h('div', { className: 'field check' }, keepHair,
      h('label', { text: 'Worn on the face — keep hair visible (hides_hair = false)' }));

    var form = h('div', { className: 'gearform' },
      h('div', { className: 'form' },
        field('Slot', slot),
        field('Name', name, 'Lowercase, numbers and underscores. Becomes the file name.'),
        field('Description', what),
        tintField, kindField, keepField,
        field('Variants', variants, 'Generate several and keep the best.'),
        h('div', { className: 'inline' },
          h('button', { className: 'primary', text: 'Generate', onclick: generate }),
          h('button', { text: 'API key…', title: 'Set up the Gemini key (opens a local file)', onclick: showKeySetup })),
        h('div', { id: 'gearstatus', className: 'note' }),
        h('div', { className: 'note sub', text: 'Needs the local gear server running with a Gemini key. Output saves into art/sprites/paperdoll/.' })
      ));
    form._tintField = tintField; form._kindField = kindField; form._keepField = keepField;

    outEl = h('div', { className: 'gearout' });
    root = h('div', { id: 'gearview' }, form, outEl);
    document.body.appendChild(root);
    statusEl = form.querySelector('#gearstatus');
    refreshConditional();
  }

  function refreshConditional() {
    var s = fields.slot.value;
    root.querySelector('.gearform')._tintField.style.display = (s === 'hair') ? 'none' : '';
    root.querySelector('.gearform')._kindField.style.display = (s === 'weapon') ? '' : 'none';
    root.querySelector('.gearform')._keepField.style.display = (s === 'helm') ? '' : 'none';
  }

  function setStatus(msg, cls) {
    statusEl.textContent = msg || '';
    statusEl.className = 'note' + (cls ? ' ' + cls : '');
  }

  function ping() {
    return fetch('/gear/ping').then(function (r) { return r.json(); }).then(function (j) {
      serverOk = !!(j && j.ok); hasKey = !!(j && j.has_key); return serverOk;
    }).catch(function () { serverOk = false; return false; });
  }

  function openKeyFile() {
    fetch('/gear/open-key-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        setStatus(res.opened
          ? 'Opened ' + res.path + ' — paste your key on its own line, save the file, then click Re-check.'
          : 'Edit ' + res.path + ' by hand: add your key on its own line, save, then click Re-check.', 'dirty');
      })
      .catch(function (e) { setStatus('Could not reach the server: ' + e.message, 'bad'); });
  }

  function recheckKey() {
    ping().then(function (ok) {
      if (!ok) { setStatus('Gear server not found.', 'bad'); return; }
      if (hasKey) { setStatus('Key found — ready to generate.', 'clean'); outEl.innerHTML = ''; }
      else { setStatus('Still no key in the file. Paste it, save the file, then Re-check.', 'bad'); }
    });
  }

  function keyField() {
    var stored = localStorage.getItem(KEY_LS) || '';
    var input = h('input', { type: 'password', value: stored, placeholder: 'Gemini API key', style: 'max-width:320px' });
    return h('div', { className: 'pick' },
      h('div', { className: 'note', text: 'No Gemini key found. Recommended: open the key file, paste your key in it (Notepad), save, then Re-check. The key stays on your machine and out of the browser and git.' }),
      h('div', { className: 'inline' },
        h('button', { className: 'primary', text: 'Open key file', onclick: openKeyFile }),
        h('button', { text: 'Re-check', onclick: recheckKey })),
      h('div', { className: 'note sub', text: 'Or keep it in this browser instead:' }),
      h('div', { className: 'inline' },
        input,
        h('button', { text: 'Save in browser', onclick: function () { localStorage.setItem(KEY_LS, input.value.trim()); setStatus('Key saved in this browser.', 'clean'); outEl.innerHTML = ''; } })));
  }

  function showKeySetup() { setStatus(''); outEl.innerHTML = ''; outEl.appendChild(keyField()); }

  function show() {
    ensureDom();
    E.screen = 'gear';
    root.style.display = 'flex';
    ['left', 'right', 'cellinfo'].forEach(function (id) { var el = document.getElementById(id); if (el) el.style.display = 'none'; });
    Panels.toolbar();
    ping().then(function (ok) {
      if (!ok) {
        setStatus('Asset server not found. Run:  python3 tools/asset_server.py  (with GOOGLE_API set), then reload.', 'bad');
      } else if (!hasKey && !localStorage.getItem(KEY_LS)) {
        showKeySetup();
      } else {
        setStatus('Ready.');
      }
    });
  }

  function hide() {
    E.screen = 'map';
    if (root) root.style.display = 'none';
    ['left', 'right'].forEach(function (id) { var el = document.getElementById(id); if (el) el.style.display = ''; });
    var ci = document.getElementById('cellinfo'); if (ci) ci.style.display = '';
    Panels.toolbar(); E.redraw();
  }

  function generate() {
    var body = {
      slot: fields.slot.value,
      name: fields.name.value.trim(),
      what: fields.what.value.trim(),
      tint: fields.slot.value === 'hair' ? '' : fields.tint.value.trim(),
      kind: fields.slot.value === 'weapon' ? fields.kind.value : '',
      keep_hair: fields.slot.value === 'helm' ? fields.keepHair.checked : false,
      variants: Number(fields.variants.value) || 1
    };
    if (!/^[a-z0-9_]+$/.test(body.name)) { setStatus('Name must be snake_case (lowercase letters, numbers, underscores).', 'bad'); return; }
    if (!body.what) { setStatus('Describe what the item looks like.', 'bad'); return; }
    var k = localStorage.getItem(KEY_LS); if (k) body.google_api = k;

    setStatus('Generating ' + (body.variants > 1 ? body.variants + ' candidates' : '') + '… (Nano Banana takes a few seconds each)', 'dirty');
    outEl.innerHTML = '';
    fetch('/gear/make', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res.error === 'no_key') { setStatus('No Gemini key.', 'bad'); showKeySetup(); return; }
        if (res.error) { setStatus('Failed: ' + res.error, 'bad'); return; }
        setStatus('Done — review below and Save the one you like.', 'clean');
        res.variants.forEach(function (v) { outEl.appendChild(card(v)); });
      })
      .catch(function (e) { setStatus('Request failed: ' + e.message + ' (is the gear server running?)', 'bad'); });
  }

  function dataUrl(b64) { return 'data:image/png;base64,' + b64; }

  function card(v) {
    var head = h('div', { className: 'gearcard-head' },
      h('strong', { text: v.fname }), '  ·  ' + v.solid_px + ' fixed px  ·  mask: ' + (v.has_mask ? 'yes' : 'no'));
    var review = h('img', { src: dataUrl(v.review), className: 'gearreview', alt: 'review sheet' });

    // Save-as: the prefix is fixed by the slot; you choose the rest. Defaults to the name
    // without the _vN suffix, so keeping one candidate gives a clean name, and keeping both
    // nudges you to rename the second (the server refuses to silently overwrite).
    var nameInput = h('input', { value: v.name.replace(/_v\d+$/, ''), style: 'max-width:200px' });
    var saved = h('div', { className: 'note' });
    var rowBox = h('pre', { className: 'gearrow' });
    function destFname() { return v.prefix + '_' + nameInput.value.trim(); }
    function updateRow() {
      var lines = ['worn_sprite: ' + destFname() + '.png', 'slot: ' + v.slot];
      if (v.has_mask) lines.push('default_tint: ' + (v.slot === 'hair' ? 'hair_brown' : CLOTH_TINTS[0]) + '   (pick one)');
      if (v.hides_hair !== null && v.hides_hair !== undefined) lines.push('hides_hair: ' + v.hides_hair);
      rowBox.textContent = lines.join('\n');
    }
    nameInput.addEventListener('input', updateRow); updateRow();

    function doSave(confirm) {
      var dest = nameInput.value.trim();
      if (!/^[a-z0-9_]+$/.test(dest)) { saved.textContent = 'Save-as name must be snake_case.'; saved.className = 'note bad'; return; }
      saveBtn.disabled = true; saved.textContent = 'Saving…'; saved.className = 'note';
      fetch('/gear/save', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fname: v.fname, dest_fname: destFname(), confirm: !!confirm }) })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          saveBtn.disabled = false;
          if (res.needs_confirm) {
            if (window.confirm(res.dest + '.png already exists in art/sprites/paperdoll/. Overwrite it?')) return doSave(true);
            saved.textContent = 'Not saved — ' + res.dest + ' already exists. Rename to keep both.'; saved.className = 'note';
            return;
          }
          if (res.error) { saved.textContent = 'Save failed: ' + res.error; saved.className = 'note bad'; }
          else { saved.textContent = 'Saved: ' + res.saved.join(', '); saved.className = 'note clean'; }
        })
        .catch(function (e) { saveBtn.disabled = false; saved.textContent = 'Save failed: ' + e.message; saved.className = 'note bad'; });
    }
    var saveBtn = h('button', { className: 'primary', text: 'Save', onclick: function () { doSave(false); } });

    return h('div', { className: 'gearcard' },
      head,
      h('div', { className: 'gearprev' }, review),
      v.has_mask ? tintPreview(v) : null,
      h('div', { className: 'sub', text: 'Save as' }),
      h('div', { className: 'inline' }, h('span', { className: 'note', text: v.prefix + '_' }), nameInput, h('span', { className: 'note', text: '.png' })),
      h('div', { className: 'sub', text: 'Suggested Items row' }), rowBox,
      h('div', { className: 'inline' }, saveBtn, saved));
  }

  // Live recolour across tint presets (reuses the game's Tint.getTintedLayer), for masked items.
  function tintPreview(v) {
    var presets = v.slot === 'hair' ? HAIR_TINTS : CLOTH_TINTS;
    var scale = 5;
    var canvas = h('canvas', { width: 32 * scale, height: 48 * scale, className: 'thumb', style: 'width:' + (32 * scale) + 'px;height:' + (48 * scale) + 'px;background:#262a33' });
    var layerImg = new Image(), maskImg = new Image();
    var loaded = 0;
    function onload() { if (++loaded === 2) draw(presets[0]); }
    layerImg.onload = onload; maskImg.onload = onload;
    layerImg.src = dataUrl(v.layer); maskImg.src = dataUrl(v.tint);

    function draw(preset) {
      var g = canvas.getContext('2d'); g.imageSmoothingEnabled = false;
      g.clearRect(0, 0, canvas.width, canvas.height);
      var ramp = (typeof Tint !== 'undefined') ? Tint.TINTS[preset] : null;
      var tinted = (typeof Tint !== 'undefined') ? Tint.getTintedLayer(layerImg, maskImg, ramp) : layerImg;
      if (v.slot === 'back') { g.drawImage(tinted, 0, 0, canvas.width, canvas.height); if (bodyImg.complete) g.drawImage(bodyImg, 0, 0, canvas.width, canvas.height); }
      else { if (bodyImg.complete) g.drawImage(bodyImg, 0, 0, canvas.width, canvas.height); g.drawImage(tinted, 0, 0, canvas.width, canvas.height); }
    }
    var buttons = h('div', { className: 'chips' }, presets.map(function (p) {
      return h('button', { className: 'chip', text: p.replace('hair_', ''), onclick: function () { draw(p); } });
    }));
    return h('div', { className: 'geartints' },
      h('div', { className: 'sub', text: 'Tint preview (on a survivor body)' }),
      h('div', { className: 'inline' }, canvas, buttons));
  }

  return { show: show, hide: hide, ensureDom: ensureDom };
})();
