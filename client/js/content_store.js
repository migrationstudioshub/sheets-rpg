/**
 * Content draft store + publish helper — the local "create → test → deploy" loop.
 *
 *   - The Content Studio edits a LOCAL draft (the whole `tables` object) in this browser; nothing
 *     touches the live database until Publish.
 *   - The game's Offline mode reads that draft, so Play-test runs the real rules against your edits
 *     with no deploy and no cost.
 *   - Publish POSTs the draft through the Cloud Function's key-gated endpoint, which writes Firestore.
 *   - Export downloads the draft as JSON (for a repo snapshot / git history).
 *
 * `tables` here is the same shape the game data has always had: { Items:[rows], Monsters:[rows], ... }.
 * Classic script, global `ContentStore`.
 */
var ContentStore = (function () {
  var DRAFT_KEY = 'sheetsrpg.contentDraft';

  function getDraft() {
    try { return JSON.parse(localStorage.getItem(DRAFT_KEY)); } catch (e) { return null; }
  }
  function setDraft(tables) {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(tables)); return true; } catch (e) { return false; }
  }
  function clearDraft() { localStorage.removeItem(DRAFT_KEY); }
  function hasDraft() { return !!localStorage.getItem(DRAFT_KEY); }

  /** The current live content, as raw records, from the function (Firestore). Returns a tables object. */
  function loadRecords(functionUrl) {
    return fetch(functionUrl + '?action=records').then(function (r) { return r.json(); })
      .then(function (res) {
        if (res.error) throw new Error(res.error);
        return res.tables || {};          // null before the first publish → an empty base
      });
  }

  /** Publish a tables object to Firestore through the key-gated endpoint. */
  function publish(functionUrl, key, tables) {
    return fetch(functionUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'publish', key: key, tables: tables })
    }).then(function (r) { return r.json(); })
      .then(function (res) { if (res.error) throw new Error(res.error); return res; });
  }

  function exportFile(tables, name) {
    var blob = new Blob([JSON.stringify(tables, null, 1)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name || 'content.json';
    document.body.appendChild(a); a.click(); a.remove();
  }

  return { DRAFT_KEY: DRAFT_KEY, getDraft: getDraft, setDraft: setDraft, clearDraft: clearDraft,
    hasDraft: hasDraft, loadRecords: loadRecords, publish: publish, exportFile: exportFile };
})();
if (typeof module !== 'undefined') module.exports = ContentStore;
