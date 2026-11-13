/**
 * Shell behaviour. The top nav (4 big tabs) stays visible; clicking a tab asks the Electron main
 * process to load that tool in a view below the nav (window.desktop.navigate). The title acts as a
 * Home button, which detaches the tool view and reveals the LAN host + status panel underneath.
 * Talks to main via window.desktop (see preload.js). Degrades gracefully in a plain browser.
 */
'use strict';
(function () {
  var D = window.desktop || null;
  var $ = function (id) { return document.getElementById(id); };
  var TOOLS = ['content', 'editor', 'studio', 'play'];

  function setArt(ok, mode) {
    var dot = $('artdot'), label = $('artlabel'), tag = $('studiotag'), tab = $('studiotab');
    if (ok) {
      dot.className = 'dot ok'; label.textContent = 'Art engine ready';
      tag.style.display = 'none'; tab.classList.remove('disabled');
    } else {
      dot.className = 'dot off';
      label.textContent = mode === 'fallback' ? 'Art engine offline (Python not found)' : 'Art engine offline';
      tag.style.display = ''; tab.classList.add('disabled');   // generation won't work without the art server
    }
  }

  function setActive(tool) {
    document.querySelectorAll('.tab').forEach(function (b) { b.classList.toggle('active', b.dataset.tool === tool); });
    $('homebody').style.display = tool && tool !== 'home' ? 'none' : '';   // hide the Home panel while a tool is up
  }

  function renderAddrs(lan) {
    var box = $('addrs'); box.innerHTML = '';
    if (!lan || !lan.running) return;
    if (!lan.addresses.length) { box.innerHTML = '<span class="hint">Starting…</span>'; return; }
    box.innerHTML = '<span class="hint">Open on another device on the same WiFi:</span>';
    lan.addresses.forEach(function (url) {
      var a = document.createElement('a');
      a.textContent = url; a.href = url; a.title = 'Open';
      a.onclick = function (e) { e.preventDefault(); if (D) D.openExternal(url); else window.open(url, '_blank'); };
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

  // Report the chrome height to main so the tool view sits exactly below the nav; re-report on resize.
  function reportNav() { if (D) D.setNavHeight($('chrome').offsetHeight); }

  // Tab clicks: in the app, ask main to swap the tool view; in a plain browser, just navigate.
  function wireTabs() {
    document.querySelectorAll('.tab').forEach(function (b) {
      b.onclick = function () {
        var tool = b.dataset.tool;
        if (D) D.navigate(tool);
        else window.location.href = tool === 'play' ? '/client/?offline' : '/' + tool + '/';
      };
    });
    $('homebtn').onclick = function () { if (D) D.navigate('home'); };
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

  wireTabs();

  if (!D) {
    // Plain-browser fallback (served statically without Electron): tabs still navigate; launcher controls don't work.
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
  D.onNavActive(setActive);

  reportNav();
  window.addEventListener('resize', reportNav);
  if (window.ResizeObserver) new ResizeObserver(reportNav).observe($('chrome'));

  setActive('home');
  refresh();
})();
