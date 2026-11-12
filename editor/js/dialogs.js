/**
 * Tiny in-page prompt dialog.
 *
 * The browser's native window.prompt() is NOT supported inside Electron (the desktop app) — calling it
 * throws, which previously hung the editor (e.g. saving would freeze at "saving…" when it asked for the
 * editor key). This is a drop-in, Promise-based replacement that works in both the desktop app and a
 * normal browser. (confirm()/alert() still work in Electron, so only prompt() needed replacing.)
 *
 *   Dialogs.prompt('Message', 'default', { password: true }).then(function (value) { ... });
 *
 * Resolves to the entered string, or null if cancelled. Classic script, global `Dialogs`.
 */
var Dialogs = (function () {
  function prompt(message, def, opts) {
    opts = opts || {};
    // Never stack dialogs: drop any that is somehow still open (e.g. a wedged earlier attempt).
    Array.prototype.forEach.call(document.querySelectorAll('.sheetsrpg-dialog'), function (n) { n.remove(); });
    return new Promise(function (resolve) {
      var done = false;
      function close(val) {
        if (done) return; done = true;
        document.removeEventListener('keydown', onKey, true);
        if (bg.parentNode) bg.parentNode.removeChild(bg);
        resolve(val);
      }
      function onKey(e) {
        if (e.key === 'Enter') { e.preventDefault(); close(input.value); }
        else if (e.key === 'Escape') { e.preventDefault(); close(null); }
      }

      var bg = document.createElement('div');
      bg.className = 'sheetsrpg-dialog';
      bg.style.cssText = 'position:fixed;inset:0;background:rgba(8,9,12,.6);z-index:9999;' +
        'display:flex;align-items:center;justify-content:center;';
      bg.addEventListener('mousedown', function (e) { if (e.target === bg) close(null); });

      var box = document.createElement('div');
      box.style.cssText = 'background:#1b1e25;border:1px solid #2c313c;border-radius:10px;padding:16px;' +
        'width:min(420px,90vw);box-shadow:0 10px 40px rgba(0,0,0,.5);' +
        'font:13px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;color:#e6e4df;';

      var msg = document.createElement('div');
      msg.textContent = message || '';
      msg.style.cssText = 'margin-bottom:10px;white-space:pre-wrap;color:#cfccc4;';

      var input = document.createElement('input');
      input.type = opts.password ? 'password' : 'text';
      input.value = def == null ? '' : String(def);
      if (opts.password) input.autocomplete = 'off';
      input.style.cssText = 'width:100%;font:inherit;color:#e6e4df;background:#262a33;' +
        'border:1px solid #2c313c;border-radius:6px;padding:6px 8px;';

      var row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px;';
      var cancel = document.createElement('button');
      cancel.textContent = 'Cancel';
      cancel.style.cssText = 'font:inherit;color:#e6e4df;background:#262a33;border:1px solid #2c313c;border-radius:6px;padding:5px 12px;cursor:pointer;';
      cancel.onclick = function () { close(null); };
      var ok = document.createElement('button');
      ok.textContent = 'OK';
      ok.style.cssText = 'font:inherit;color:#fff;background:#3d6fb6;border:1px solid #3d6fb6;border-radius:6px;padding:5px 12px;cursor:pointer;';
      ok.onclick = function () { close(input.value); };

      row.appendChild(cancel); row.appendChild(ok);
      box.appendChild(msg); box.appendChild(input); box.appendChild(row);
      bg.appendChild(box);
      document.body.appendChild(bg);
      document.addEventListener('keydown', onKey, true);
      // Focus reliably even if something grabs focus right after we open (retry on the next tick/frame).
      function focusInput() { try { input.focus(); input.select(); } catch (e) { /* ignore */ } }
      focusInput();
      setTimeout(focusInput, 0);
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focusInput);
    });
  }

  return { prompt: prompt };
})();
if (typeof module !== 'undefined') module.exports = Dialogs;
