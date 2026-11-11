/**
 * Asset Studio shell: a tiny host for the three offline art makers (Gear, Tileset, Objects).
 *
 * The makers were written as editor screens, so they expect two editor globals:
 *   E.screen / E.redraw()  and  Panels.toolbar().
 * Here we provide minimal stand-ins so the maker modules run unchanged — E.screen is just the
 * active tab, E.redraw is a no-op, and Panels.toolbar() redraws the studio's tab bar. Each maker's
 * show() builds its own DOM (#gearview / #tilesetview / #objectsview) and hides the editor panels
 * (#left/#right/#cellinfo), which simply don't exist here, so those lookups no-op.
 *
 * Classic script (no modules). Loaded before the maker modules; init() runs after they load.
 */
var Studio = (function () {
  // The editor globals the makers reach for. Kept on window so the maker IIFEs see them.
  window.E = window.E || { screen: 'gear', redraw: function () {} };

  var TABS = [['gear', 'Gear'], ['tileset', 'Tileset'], ['object', 'Objects']];
  var MOD = {
    gear: function () { return typeof Gear !== 'undefined' ? Gear : null; },
    tileset: function () { return typeof Tileset !== 'undefined' ? Tileset : null; },
    object: function () { return typeof MapObjects !== 'undefined' ? MapObjects : null; }
  };

  function renderTabs() {
    var bar = document.getElementById('studiobar');
    if (!bar) return;
    bar.innerHTML = '';
    var title = document.createElement('strong'); title.textContent = 'Asset Studio';
    var lbl = document.createElement('span'); lbl.className = 'lbl'; lbl.textContent = 'offline art generator';
    var group = document.createElement('div'); group.className = 'group';
    group.appendChild(title); group.appendChild(lbl);
    bar.appendChild(group);

    var tabs = document.createElement('span'); tabs.className = 'layer';
    TABS.forEach(function (t) {
      var b = document.createElement('button');
      b.textContent = t[1];
      if (E.screen === t[0]) b.className = 'on';
      b.onclick = function () { showMaker(t[0]); };
      tabs.appendChild(b);
    });
    var right = document.createElement('div'); right.className = 'group right'; right.appendChild(tabs);
    bar.appendChild(right);
  }

  // The makers call Panels.toolbar() from their show(); route it to our tab bar.
  window.Panels = window.Panels || {};
  window.Panels.toolbar = renderTabs;

  function showMaker(name) {
    ['gearview', 'tilesetview', 'objectsview'].forEach(function (id) {
      var el = document.getElementById(id); if (el) el.style.display = 'none';
    });
    var m = MOD[name] && MOD[name]();
    if (m) m.show();        // sets E.screen, builds/shows its root, calls Panels.toolbar()
    else renderTabs();
  }

  function init() { renderTabs(); showMaker('gear'); }

  return { init: init, showMaker: showMaker, renderTabs: renderTabs };
})();
