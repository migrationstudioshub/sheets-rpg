/**
 * Map-object maker: a separate editor screen that drives the object pipeline
 * (tools/objpipe via tools/gear_server.py), the same way make_objects.py does on the CLI.
 *
 * Offline only (needs Gemini + Python/Pillow/numpy). Classic script (no modules), global `MapObjects`.
 *   GET  /gear/ping                  -> { ok, has_key }
 *   POST /object/make {name,what,size,box?,views?,free_top?,variants?,google_api?}
 *        -> { name, variants:[{file,name,b64,w,h,tiles_w}], review, suggest }
 *   POST /object/save {fname, dest_fname, confirm?} -> { saved:[paths] } | { needs_confirm, dest }
 */
var MapObjects = (function () {
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
    var name = h('input', { placeholder: 'snake_case id, e.g. bookshelf' });
    var what = h('textarea', { rows: 2, placeholder: 'what it looks like, e.g. "a tall wooden bookshelf with a few dusty books"' });
    var size = h('input', { placeholder: 'W,H,D in metres, e.g. 1.0,1.9,0.4', value: '1.0,1.0,0.6' });
    var box = h('input', { placeholder: 'optional WxH px override, e.g. 26x40' });
    var down = h('input', { type: 'checkbox', checked: true });
    var up = h('input', { type: 'checkbox' });
    var side = h('input', { type: 'checkbox' });
    var freeTop = h('input', { type: 'checkbox' });
    var variants = h('select', {}, [1, 2, 3].map(function (n) { return h('option', { value: String(n), text: n + (n > 1 ? ' candidates' : ' candidate') }); }));
    variants.value = '2';
    fields = { name: name, what: what, size: size, box: box, down: down, up: up, side: side, freeTop: freeTop, variants: variants };

    var views = h('div', { className: 'inline' },
      h('label', { className: 'field check' }, down, ' down'),
      h('label', { className: 'field check' }, up, ' up'),
      h('label', { className: 'field check' }, side, ' side'));

    var form = h('div', { className: 'gearform' },
      h('div', { className: 'form' },
        field('Name', name, 'Lowercase, numbers, underscores. Becomes the file name.'),
        field('Description', what),
        field('Size (m)', size, 'Real width,height,depth. The 32×48 human is 1.8 m; sets the canvas by the size rule.'),
        field('Box override (optional)', box, 'Force the object box inside the canvas (chairs read better a bit bigger).'),
        field('Views', views, 'down faces the viewer; up = from behind; side faces right (mirror for left).'),
        h('div', { className: 'field check' }, freeTop, h('label', { text: 'Free top (cars, trees, round tops — don’t square the top)' })),
        field('Variants', variants, 'Generate several and keep the best.'),
        h('div', { className: 'inline' },
          h('button', { className: 'primary', text: 'Generate', onclick: generate }),
          h('button', { text: 'API key…', title: 'Set up the Gemini key (opens a local file)', onclick: showKeySetup })),
        h('div', { id: 'objstatus', className: 'note' }),
        h('div', { className: 'note sub', text: 'Needs the local server running with a Gemini key. Saves into art/sprites/objects/.' })
      ));

    outEl = h('div', { className: 'gearout' });
    root = h('div', { id: 'objectsview', className: 'makerview' }, form, outEl);
    document.body.appendChild(root);
    statusEl = form.querySelector('#objstatus');
  }

  // ---- shared key handling ----
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
      h('div', { className: 'note', text: 'No Gemini key found. Recommended: open the key file, paste your key, save, then Re-check. It stays out of the browser and git.' }),
      h('div', { className: 'inline' },
        h('button', { className: 'primary', text: 'Open key file', onclick: openKeyFile }),
        h('button', { text: 'Re-check', onclick: recheckKey })),
      h('div', { className: 'note sub', text: 'Or keep it in this browser instead:' }),
      h('div', { className: 'inline' }, input,
        h('button', { text: 'Save in browser', onclick: function () { localStorage.setItem(KEY_LS, input.value.trim()); setStatus('Key saved in this browser.', 'clean'); outEl.innerHTML = ''; } })));
  }
  function showKeySetup() { setStatus(''); outEl.innerHTML = ''; outEl.appendChild(keyField()); }

  function generate() {
    var views = [];
    if (fields.down.checked) views.push('down');
    if (fields.up.checked) views.push('up');
    if (fields.side.checked) views.push('side');
    if (!views.length) views = ['down'];
    var body = {
      name: fields.name.value.trim(), what: fields.what.value.trim(), size: fields.size.value.trim(),
      box: fields.box.value.trim(), views: views.join(','), free_top: fields.freeTop.checked,
      variants: Number(fields.variants.value) || 1
    };
    if (!/^[a-z0-9_]+$/.test(body.name)) { setStatus('Name must be snake_case (lowercase letters, numbers, underscores).', 'bad'); return; }
    if (!body.what) { setStatus('Describe the object.', 'bad'); return; }
    if (!/^\s*[0-9.]+\s*,\s*[0-9.]+\s*,\s*[0-9.]+\s*$/.test(body.size)) { setStatus('Size must be W,H,D in metres, e.g. 1.0,1.9,0.4', 'bad'); return; }
    var k = localStorage.getItem(KEY_LS); if (k) body.google_api = k;

    setStatus('Generating ' + (body.variants > 1 ? body.variants + ' candidates' : '') + ' × ' + views.length + ' view(s)… (a few seconds each)', 'dirty');
    outEl.innerHTML = '';
    fetch('/object/make', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res.error === 'no_key') { setStatus('No Gemini key.', 'bad'); showKeySetup(); return; }
        if (res.error) { setStatus('Failed: ' + res.error, 'bad'); return; }
        setStatus('Done — review below and Save the ones you like.', 'clean');
        if (res.review) outEl.appendChild(h('div', { className: 'gearcard' },
          h('div', { className: 'gearcard-head' }, h('strong', { text: 'Review (candidates at 1× / 4×, bust for scale)' })),
          h('img', { src: dataUrl(res.review.b64), className: 'gearreview', alt: 'review' })));
        var suggest = h('pre', { className: 'gearrow', text: res.suggest || '' });
        res.variants.forEach(function (v) { outEl.appendChild(card(v)); });
        outEl.appendChild(h('div', { className: 'gearcard' }, h('div', { className: 'sub', text: 'Suggested data rows' }), suggest));
      })
      .catch(function (e) { setStatus('Request failed: ' + e.message + ' (is the server running?)', 'bad'); });
  }

  function card(v) {
    var scale = Math.max(2, Math.min(6, Math.round(192 / Math.max(v.w, v.h))));
    var head = h('div', { className: 'gearcard-head' },
      h('strong', { text: v.name }), '  ·  ' + v.w + '×' + v.h + ' px  ·  ' + v.tiles_w + ' tile(s) wide');
    var img = h('img', { src: dataUrl(v.b64), alt: v.name,
      style: 'image-rendering:pixelated;background:#262a33;border-radius:4px;width:' + (v.w * scale) + 'px;height:' + (v.h * scale) + 'px' });

    var defName = v.name.replace(/_v\d+$/, '');
    var nameInput = h('input', { value: defName, style: 'max-width:200px' });
    var saved = h('div', { className: 'note' });

    function doSave(confirm) {
      var dest = nameInput.value.trim();
      if (!/^[a-z0-9_]+$/.test(dest)) { saved.textContent = 'Save-as name must be snake_case.'; saved.className = 'note bad'; return; }
      saveBtn.disabled = true; saved.textContent = 'Saving…'; saved.className = 'note';
      fetch('/object/save', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fname: v.name, dest_fname: dest, confirm: !!confirm }) })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          saveBtn.disabled = false;
          if (res.needs_confirm) {
            if (window.confirm(res.dest + '.png already exists in art/sprites/objects/. Overwrite it?')) return doSave(true);
            saved.textContent = 'Not saved — ' + res.dest + ' exists. Rename to keep both.'; saved.className = 'note'; return;
          }
          if (res.error) { saved.textContent = 'Save failed: ' + res.error; saved.className = 'note bad'; }
          else { saved.textContent = 'Saved: ' + res.saved.join(', '); saved.className = 'note clean'; }
        })
        .catch(function (e) { saveBtn.disabled = false; saved.textContent = 'Save failed: ' + e.message; saved.className = 'note bad'; });
    }
    var saveBtn = h('button', { className: 'primary', text: 'Save', onclick: function () { doSave(false); } });

    return h('div', { className: 'gearcard' }, head, h('div', { className: 'gearprev' }, img),
      h('div', { className: 'sub', text: 'Save as' }),
      h('div', { className: 'inline' }, nameInput, h('span', { className: 'note', text: '.png' })),
      h('div', { className: 'inline' }, saveBtn, saved));
  }

  function show() {
    ensureDom();
    E.screen = 'object';
    ['gearview', 'tilesetview'].forEach(function (id) { var el = document.getElementById(id); if (el) el.style.display = 'none'; });
    root.style.display = 'flex';
    ['left', 'right', 'cellinfo'].forEach(function (id) { var el = document.getElementById(id); if (el) el.style.display = 'none'; });
    Panels.toolbar();
    ping().then(function (ok) {
      if (!ok) setStatus('Server not found. Run:  python3 tools/gear_server.py  (with GOOGLE_API set), then reload.', 'bad');
      else if (!hasKey && !localStorage.getItem(KEY_LS)) showKeySetup();
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
