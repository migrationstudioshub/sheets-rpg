/**
 * Launcher behaviour. Talks to the Electron main process via window.desktop (see preload.js).
 * Degrades gracefully when opened WITHOUT Electron (e.g. a plain browser): the tool tiles are
 * normal links that still work, and the LAN panel explains it needs the desktop app.
 */
'use strict';
(function () {
  var D = window.desktop || null;
  var $ = function (id) { return document.getElementById(id); };

  function setArt(ok, mode) {
    var dot = $('artdot'), label = $('artlabel'), tag = $('studiotag'), tile = $('studiotile');
    if (ok) {
      dot.className = 'dot ok'; label.textContent = 'Art engine ready';
      tag.style.display = 'none'; tile.classList.remove('disabled');
    } else {
      dot.className = 'dot off';
      label.textContent = mode === 'fallback' ? 'Art engine offline (Python not found)' : 'Art engine offline';
      tag.style.display = ''; // generation won't work; the page still opens and explains why
    }
  }

  function renderAddrs(lan) {
    var box = $('addrs'); box.innerHTML = '';
    if (!lan || !lan.running) return;
    if (!lan.addresses.length) {
      box.innerHTML = '<span class="hint">Starting…</span>';
      return;
    }
    box.innerHTML = '<span class="hint">Open on another device on the same WiFi:</span>';
    lan.addresses.forEach(function (url) {
      var a = document.createElement('a');
      a.textContent = url; a.href = url; a.title = 'Open';
      a.onclick = function (e) {
        e.preventDefault();
        if (D) D.openExternal(url); else window.open(url, '_blank');
      };
      box.appendChild(a);
    });
  }

  function setLan(lan) {
    var running = lan && lan.running;
    $('lanstart').disabled = !!running;
    $('lanstop').disabled = !running;
    $('lanstatus').textContent = running ? ('running on port ' + lan.port) : '';
    renderAddrs(lan);
  }

  function refresh() {
    if (!D) return;
    D.getStatus().then(function (s) {
      setArt(s.artOk, s.mode);
      $('port').textContent = s.port;
      $('projpath').textContent = s.projectRoot || '—';
      setLan(s.lan);
    });
  }

  if (!D) {
    // Plain-browser fallback (sandbox / served statically without Electron).
    $('artlabel').textContent = 'Opened in a browser — launcher controls need the desktop app';
    $('artdot').className = 'dot off';
    $('projpath').textContent = 'n/a';
    $('port').textContent = location.port || '—';
    $('lanstart').disabled = true;
    $('lanstatus').textContent = 'Available in the desktop app';
    return;
  }

  $('projpath').onclick = function () { D.revealProject(); };
  $('lanstart').onclick = function () {
    $('lanstart').disabled = true; $('lanstatus').textContent = 'starting…';
    $('lanlog').classList.add('show');
    D.startLan().then(setLan);
  };
  $('lanstop').onclick = function () { D.stopLan().then(setLan); };

  D.onLanState(setLan);
  D.onLanLog(function (line) {
    var log = $('lanlog');
    log.textContent += line.replace(/\s+$/, '') + '\n';
    log.scrollTop = log.scrollHeight;
  });

  refresh();
})();
