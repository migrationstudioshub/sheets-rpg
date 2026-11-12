/**
 * Tileset maker: a separate editor screen that drives the ground/wall tile pipeline
 * (tools/tilepipe via tools/gear_server.py), the same way make_tileset.py does on the CLI.
 *
 * Offline only (needs Gemini + Python/Pillow/numpy). When the local server isn't there it
 * explains how to start it. Walls are procedural, so they generate even without a Gemini key.
 *
 * Classic script (no modules), global `Tileset`. Local API:
 *   GET  /gear/ping                          -> { ok, has_key }
 *   POST /tile/make {kind,name,what?,decals?,material?,google_api?}
 *        -> { kind, name, images:{auto,base,details,decals,review | top,face,review}, scatter, suggest }
 *   POST /tile/save {name, kind, confirm?}   -> { saved:[paths] } | { needs_confirm, dest }
 */
var Tileset = (function () {
  var KEY_LS = 'sheetsrpg.googleKey';
  var root = null, fields = null, statusEl = null, outEl = null, serverOk = false, hasKey = false;

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
  function dataUrl(b64) { return 'data:image/png;base64,' + b64; }
  function setStatus(msg, cls) { statusEl.textContent = msg || ''; statusEl.className = 'note' + (cls ? ' ' + cls : ''); }

  function ensureDom() {
    if (root) return;
    var kind = h('select', { onchange: refreshConditional }, [
      h('option', { value: 'ground', text: 'Ground terrain (autotile)' }),
      h('option', { value: 'plain', text: 'Plain tile (no autotiling)' }),
      h('option', { value: 'wall', text: 'Wall (top + face)' })
    ]);
    var name = h('input', { placeholder: 'snake_case id, e.g. gravel or wall_concrete' });
    var what = h('textarea', { rows: 2, placeholder: 'the surface, e.g. "loose grey gravel, small stones, a few weeds"' });
    var decals = h('input', { placeholder: 'six marks, e.g. "a rock, a weed clump, a bolt, a puddle, pebbles, a crushed can"' });
    var material = h('select', {}, [h('option', { value: 'brick', text: 'brick' }), h('option', { value: 'concrete', text: 'concrete' })]);
    var pattern = h('input', { type: 'checkbox' });
    fields = { kind: kind, name: name, what: what, decals: decals, material: material, pattern: pattern };

    var whatField = field('Surface', what, 'What the ground is. Fills the tile edge to edge, no borders.');
    var decalsField = field('Decals (optional)', decals, 'Bigger marks scattered on interior cells. One Gemini image.');
    var matField = field('Material', material, 'Walls are procedural (no Gemini key needed).');
    var patternField = h('div', { className: 'field check' }, pattern,
      h('label', { text: 'Built surface — keep seams/welds/joints (metal plates, planks, tiles, pavers)' }));

    var form = h('div', { className: 'gearform' },
      h('div', { className: 'form' },
        field('Kind', kind),
        field('Name', name, 'Lowercase, numbers, underscores. Becomes the file names.'),
        whatField, patternField, decalsField, matField,
        h('div', { className: 'inline' },
          h('button', { className: 'primary', text: 'Generate', onclick: generate }),
          h('button', { text: 'API key…', title: 'Set up the Gemini key (opens a local file)', onclick: showKeySetup })),
        h('div', { id: 'tilestatus', className: 'note' }),
        h('div', { className: 'note sub', text: 'Needs the local server running. Saves into art/tilesets/ and merges scatter.json.' })
      ));
    form._whatField = whatField; form._decalsField = decalsField; form._matField = matField; form._patternField = patternField;

    outEl = h('div', { className: 'gearout' });
    root = h('div', { id: 'tilesetview', className: 'makerview' }, form, outEl);
    document.body.appendChild(root);
    statusEl = form.querySelector('#tilestatus');
    refreshConditional();
  }

  function refreshConditional() {
    var kind = fields.kind.value, ground = kind === 'ground', plain = kind === 'plain';
    var f = root.querySelector('.gearform');
    f._whatField.style.display = (ground || plain) ? '' : 'none';   // both need a surface texture
    f._patternField.style.display = (ground || plain) ? '' : 'none';
    f._decalsField.style.display = ground ? '' : 'none';            // plain tiles have no scatter layer
    f._matField.style.display = kind === 'wall' ? '' : 'none';
  }

  // ---- shared key handling (same local server + localStorage key as the Gear view) ----
  function ping() {
    return fetch('/gear/ping').then(function (r) { return r.json(); }).then(function (j) {
      serverOk = !!(j && j.ok); hasKey = !!(j && j.has_key); return serverOk;
    }).catch(function () { serverOk = false; return false; });
  }
  function openKeyFile() {
    fetch('/gear/open-key-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function (r) { return r.json(); })
      .then(function (res) { setStatus((res.opened ? 'Opened ' : 'Edit ') + res.path + ' — add your key on its own line, save, then Re-check.', 'dirty'); })
      .catch(function (e) { setStatus('Could not reach the server: ' + e.message, 'bad'); });
  }
  function recheckKey() {
    ping().then(function (ok) {
      if (!ok) { setStatus('Server not found.', 'bad'); return; }
      if (hasKey) { setStatus('Key found — ready to generate.', 'clean'); outEl.innerHTML = ''; }
      else { setStatus('Still no key in the file. Paste it, save, then Re-check.', 'bad'); }
    });
  }
  function keyField() {
    var stored = localStorage.getItem(KEY_LS) || '';
    var input = h('input', { type: 'password', value: stored, placeholder: 'Gemini API key', style: 'max-width:320px' });
    return h('div', { className: 'pick' },
      h('div', { className: 'note', text: 'No Gemini key found (ground needs one; walls do not). Recommended: open the key file, paste your key, save, then Re-check. It stays out of the browser and git.' }),
      h('div', { className: 'inline' },
        h('button', { className: 'primary', text: 'Open key file', onclick: openKeyFile }),
        h('button', { text: 'Re-check', onclick: recheckKey })),
      h('div', { className: 'note sub', text: 'Or keep it in this browser instead:' }),
      h('div', { className: 'inline' }, input,
        h('button', { text: 'Save in browser', onclick: function () { localStorage.setItem(KEY_LS, input.value.trim()); setStatus('Key saved in this browser.', 'clean'); outEl.innerHTML = ''; } })));
  }
  function showKeySetup() { setStatus(''); outEl.innerHTML = ''; outEl.appendChild(keyField()); }

  function generate() {
    var sel = fields.kind.value, plain = sel === 'plain', kind = plain ? 'ground' : sel;
    var body = { kind: kind, plain: plain, name: fields.name.value.trim() };
    if (kind === 'ground') { body.what = fields.what.value.trim(); body.pattern = fields.pattern.checked; if (!plain) body.decals = fields.decals.value.trim(); }
    else { body.material = fields.material.value; }
    if (!/^[a-z0-9_]+$/.test(body.name)) { setStatus('Name must be snake_case (lowercase letters, numbers, underscores).', 'bad'); return; }
    if (kind === 'ground' && !body.what) { setStatus('Describe the ' + (plain ? 'tile' : 'ground') + ' surface.', 'bad'); return; }
    var k = localStorage.getItem(KEY_LS); if (k) body.google_api = k;

    setStatus('Generating ' + sel + '… (Nano Banana takes a few seconds)', 'dirty');
    outEl.innerHTML = '';
    fetch('/tile/make', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res.error === 'no_key') { setStatus('No Gemini key (ground needs one).', 'bad'); showKeySetup(); return; }
        if (res.error) { setStatus('Failed: ' + res.error, 'bad'); return; }
        setStatus('Done — review below and Save if you like it.', 'clean');
        outEl.appendChild(card(res));
      })
      .catch(function (e) { setStatus('Request failed: ' + e.message + ' (is the server running?)', 'bad'); });
  }

  function card(res) {
    var im = res.images || {};
    var head = h('div', { className: 'gearcard-head' }, h('strong', { text: res.name }), '  ·  ' + (res.plain ? 'plain tile' : res.kind));
    var prev = h('div', { className: 'gearprev' });
    if (im.review) prev.appendChild(h('img', { src: dataUrl(im.review.b64), className: 'gearreview', alt: 'review' }));
    var sheet = im.auto || im.top;
    if (sheet) prev.appendChild(h('img', { src: dataUrl(sheet.b64), className: 'gearreview', alt: 'sheet', style: 'image-rendering:pixelated;max-width:256px' }));

    var nameInput = h('input', { value: res.name, style: 'max-width:200px' });
    var saved = h('div', { className: 'note' });
    var rowBox = h('pre', { className: 'gearrow', text: res.suggest || '' });

    function doSave(confirm) {
      var dest = nameInput.value.trim();
      if (!/^[a-z0-9_]+$/.test(dest)) { saved.textContent = 'Name must be snake_case.'; saved.className = 'note bad'; return; }
      saveBtn.disabled = true; saved.textContent = 'Saving…'; saved.className = 'note';
      fetch('/tile/save', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: dest, kind: res.kind, plain: !!res.plain, confirm: !!confirm }) })
        .then(function (r) { return r.json(); })
        .then(function (r2) {
          saveBtn.disabled = false;
          if (r2.needs_confirm) {
            if (window.confirm(r2.dest + ' already exists in art/tilesets/. Overwrite it?')) return doSave(true);
            saved.textContent = 'Not saved — ' + r2.dest + ' exists. Rename to keep both.'; saved.className = 'note'; return;
          }
          if (r2.error) { saved.textContent = 'Save failed: ' + r2.error; saved.className = 'note bad'; }
          else { saved.textContent = 'Saved: ' + r2.saved.join(', '); saved.className = 'note clean'; }
        })
        .catch(function (e) { saveBtn.disabled = false; saved.textContent = 'Save failed: ' + e.message; saved.className = 'note bad'; });
    }
    var saveBtn = h('button', { className: 'primary', text: 'Save', onclick: function () { doSave(false); } });

    return h('div', { className: 'gearcard' }, head, prev,
      h('div', { className: 'sub', text: 'Save as (the file-name stem)' }),
      h('div', { className: 'inline' }, nameInput),
      h('div', { className: 'sub', text: 'Suggested data rows' }), rowBox,
      h('div', { className: 'inline' }, saveBtn, saved));
  }

  function show() {
    ensureDom();
    E.screen = 'tileset';
    ['gearview', 'objectsview'].forEach(function (id) { var el = document.getElementById(id); if (el) el.style.display = 'none'; });
    root.style.display = 'flex';
    ['left', 'right', 'cellinfo'].forEach(function (id) { var el = document.getElementById(id); if (el) el.style.display = 'none'; });
    Panels.toolbar();
    ping().then(function (ok) {
      if (!ok) setStatus('Server not found. Run:  python3 tools/asset_server.py  then reload.', 'bad');
      else if (!hasKey && !localStorage.getItem(KEY_LS)) setStatus('Ready for walls. Ground needs a Gemini key — click “API key…”.', 'dirty');
      else setStatus('Ready.');
    });
  }
  function hide() {
    E.screen = 'map';
    if (root) root.style.display = 'none';
    ['left', 'right'].forEach(function (id) { var el = document.getElementById(id); if (el) el.style.display = ''; });
    var ci = document.getElementById('cellinfo'); if (ci) ci.style.display = '';
    Panels.toolbar(); E.redraw();
  }

  return { show: show, hide: hide, ensureDom: ensureDom };
})();
