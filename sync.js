// Sync between devices through the user's own Google Drive.
//
// VibeTime keeps one file, vibetime.json, in the hidden "app data" folder of the user's Google Drive. Only VibeTime
// (this app) can see it, it doesn't show up in their Drive, and it needs no access to anything else. Every connected
// device downloads it, merges it with its own data and uploads the result. Days are merged one by one: when the same
// day was edited on two devices, the newer edit wins. The theme stays per device.
//
// One-time setup for whoever hosts the site (free):
//   1. https://console.cloud.google.com > create a project > APIs & Services > Library > enable "Google Drive API".
//   2. OAuth consent screen > External > fill in the app name and your email > Scopes: add
//      ".../auth/drive.appdata" (it is a non-sensitive scope, so no Google review is needed) > then "Publish app".
//   3. Credentials > Create credentials > OAuth client ID > Web application > Authorized JavaScript origins:
//        https://naronitsu.github.io      (and http://localhost:8765 to test locally)
//   4. Copy the Client ID below. It is not a secret.
const GOOGLE_CLIENT_ID = '434753019077-ttr70tcnd8lpa1rc8r6r9jgbjlik0p00.apps.googleusercontent.com';

// Staying signed in: with AUTH_WORKER set (see worker/vibetime-auth.js) sign-in uses a normal Google page and a
// long-lasting token that the Worker refreshes, so you only sign in once per device. Without it, the browser-only
// fallback below is used, and Google asks for a fresh sign-in about once an hour.
const AUTH_WORKER = 'https://small-frost-4e3b.damiannav03.workers.dev';
const usingWorker = () => !!AUTH_WORKER;

const SYNC_KEY = 'vibetime.sync', SYNC_FILE = 'vibetime.json';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const syncAvailable = () => !!GOOGLE_CLIENT_ID;
const syncInfo = () => { try { return JSON.parse(localStorage.getItem(SYNC_KEY)) || null; } catch { return null; } };
const syncWrite = o => { try { o ? localStorage.setItem(SYNC_KEY, JSON.stringify(o)) : localStorage.removeItem(SYNC_KEY); } catch {} };
const syncConnected = () => { const i = syncInfo(); return !!(i && i.on); };

// ---- merging (pure; also used by the tests)
const _sorted = o => Object.fromEntries(Object.keys(o || {}).sort().map(k => [k, o[k]]));
// What counts as "the same data" when comparing devices: everything except the per-device theme.
function syncCanon(s) {
  const { theme, ...settings } = s.settings;
  return JSON.stringify({ settings: _sorted(settings), days: _sorted(s.days), mod: _sorted(s.mod), settingsMod: s.settingsMod || 0 });
}
function mergeStates(a, b) {                     // a = this device, b = the other one
  const days = {}, mod = {};
  const keys = new Set([...Object.keys(a.days), ...Object.keys(b.days), ...Object.keys(a.mod || {}), ...Object.keys(b.mod || {})]);
  for (const k of keys) {
    const ta = (a.mod || {})[k] || 0, tb = (b.mod || {})[k] || 0;
    const pick = ta > tb ? a.days[k] : tb > ta ? b.days[k] : (a.days[k] || b.days[k]);   // a missing day with the newer time = deleted
    if (pick) days[k] = pick;
    if (ta || tb) mod[k] = Math.max(ta, tb);
  }
  const useA = (a.settingsMod || 0) >= (b.settingsMod || 0);
  return { settings: { ...(useA ? a.settings : b.settings), theme: a.settings.theme }, days, mod, settingsMod: Math.max(a.settingsMod || 0, b.settingsMod || 0) };
}

// ---- status for the UI: idle | syncing | ok | error | signin (Google needs a tap to sign in again)
let _syncStatus = { state: 'idle', msg: '' };
function setSyncStatus(st, msg = '') { _syncStatus = { state: st, msg }; window.dispatchEvent(new CustomEvent('vibetime-sync', { detail: _syncStatus })); }
const syncStatus = () => _syncStatus;

// ---- Google sign-in (Google Identity Services). Access lasts about an hour; after that Google wants a quick tap.
let _gis;
const loadGis = () => _gis || (_gis = new Promise((resolve, reject) => {
  if (window.google && google.accounts && google.accounts.oauth2) return resolve();
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.onload = () => resolve();
  s.onerror = () => { _gis = null; reject(new Error('Couldn’t reach Google sign-in. Check your connection.')); };
  document.head.appendChild(s);
}));
let _client, _wait;
async function requestToken() {
  await loadGis();
  return new Promise((resolve, reject) => {
    _wait = { resolve, reject };
    _client = _client || google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID, scope: DRIVE_SCOPE,
      callback: r => r.error ? _wait.reject(Object.assign(new Error(r.error_description || r.error), { signin: true }))
        : !google.accounts.oauth2.hasGrantedAllScopes(r, DRIVE_SCOPE) ? _wait.reject(Object.assign(new Error('Google Drive access wasn’t ticked. Connect again and leave the Drive box ticked.'), { signin: true }))
        : _wait.resolve(r),
      error_callback: e => _wait.reject(Object.assign(new Error('Google sign-in was closed or blocked.'), { signin: true, type: e && e.type })),
    });
    _client.requestAccessToken({ prompt: '' });
  });
}
// ---- staying signed in through the Worker (authorization code flow with PKCE)
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const syncRedirect = () => location.origin + location.pathname.replace(/[^/]*$/, '') + 'settings.html';
async function workerCall(path, body) {
  const res = await fetch(`${AUTH_WORKER.replace(/\/+$/, '')}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j.error_description || j.error || `Sign-in helper said no (${res.status}).`), { code: j.error });
  return j;
}
async function startGoogleSignIn(after = '') {          // leaves the page for Google, and comes back to Settings
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem('vt.pkce', verifier); sessionStorage.setItem('vt.state', state); sessionStorage.setItem('vt.after', after);
  location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID, redirect_uri: syncRedirect(), response_type: 'code', scope: DRIVE_SCOPE,
    access_type: 'offline', prompt: 'consent', code_challenge: challenge, code_challenge_method: 'S256', state });
  return new Promise(() => {});                         // the page is going away
}
// Called on every page load: if we have just come back from Google, trade the code for tokens.
async function handleGoogleRedirect() {
  if (!usingWorker()) return false;
  const q = new URLSearchParams(location.search), verifier = sessionStorage.getItem('vt.pkce');
  if (!verifier || !(q.has('code') || q.has('error'))) return false;
  const want = sessionStorage.getItem('vt.state');
  sessionStorage.removeItem('vt.pkce'); sessionStorage.removeItem('vt.state');
  history.replaceState(null, '', location.pathname + location.hash);
  if (q.has('error')) { setSyncStatus('error', 'Google sign-in was cancelled.'); return true; }
  if (q.get('state') !== want) { setSyncStatus('error', 'The sign-in couldn\u2019t be verified. Please try again.'); return true; }
  try {
    const j = await workerCall('token', { code: q.get('code'), code_verifier: verifier, redirect_uri: syncRedirect() });
    if (!j.refresh_token) throw new Error('Google didn\u2019t give a long-lasting sign-in. Remove VibeTime at myaccount.google.com/permissions, then connect again.');
    syncWrite({ on: true, refresh: j.refresh_token, access: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000, last: 0 });
  } catch (err) { setSyncStatus('error', err.message === 'Failed to fetch' ? 'Couldn\u2019t reach the sign-in helper. Check AUTH_WORKER in sync.js.' : err.message); }
  return true;
}

// ---- access tokens
// In the browser-only fallback Google's sign-in window may only open from a click, so a background sync pauses instead.
let _gesture = false;
async function accessToken() {
  const i = syncInfo();
  if (!i) throw new Error('Not connected.');
  if (i.access && i.exp > Date.now() + 60000) return i.access;
  if (usingWorker()) {
    if (i.refresh) {
      try {
        const j = await workerCall('refresh', { refresh_token: i.refresh });
        syncWrite({ ...syncInfo(), access: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 });
        return j.access_token;
      } catch (err) {
        if (err.code !== 'invalid_grant') throw err;
        syncWrite({ ...syncInfo(), refresh: null, access: null });
      }
    }
    throw Object.assign(new Error('Your Google sign-in has expired. Sign in again to resume syncing.'), { signin: true });
  }
  if (!_gesture) throw Object.assign(new Error('Sync is paused. Sign in to Google again to resume.'), { signin: true });
  const r = await requestToken();
  syncWrite({ ...syncInfo(), access: r.access_token, exp: Date.now() + (Number(r.expires_in) || 3600) * 1000 });
  return r.access_token;
}
async function syncConnect(after = '') {              // call from a click
  if (!syncAvailable()) return false;
  if (usingWorker()) return startGoogleSignIn(after);
  try {
    const r = await requestToken();
    syncWrite({ on: true, access: r.access_token, exp: Date.now() + (Number(r.expires_in) || 3600) * 1000, last: 0 });
    return true;
  } catch (err) { setSyncStatus('error', err.message); return false; }
}
async function syncDisconnect() {
  const i = syncInfo();
  syncWrite(null);
  try {
    if (usingWorker()) { if (i && (i.refresh || i.access)) workerCall('revoke', { token: i.refresh || i.access }).catch(() => {}); }
    else if (i && i.access && window.google && google.accounts) google.accounts.oauth2.revoke(i.access);
  } catch {}
  setSyncStatus('idle');
}

// ---- Drive: the one file in the app data folder
async function drive(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${await accessToken()}`, ...opts.headers } });
  if (res.status === 401) { syncWrite({ ...syncInfo(), access: null }); throw Object.assign(new Error('Sign in to Google again to keep syncing.'), { signin: true }); }
  if (!res.ok) {
    let why = ''; try { why = (await res.json()).error.message; } catch {}
    throw new Error(`Google Drive said no (${res.status}${why ? ': ' + why : ''}).`);
  }
  return res;
}
async function remoteGet() {
  const q = encodeURIComponent(`name='${SYNC_FILE}' and trashed=false`);
  const list = await (await drive(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&orderBy=createdTime&fields=files(id)&pageSize=1`)).json();
  const f = list.files && list.files[0];
  if (!f) return null;                                       // no file yet
  const text = await (await drive(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`)).text();
  let data;
  try { data = migrateState(JSON.parse(text)).data; }
  catch { throw new Error('The vibetime.json file in Google Drive could not be read, so nothing was changed.'); }
  return { data, id: f.id };
}
async function remotePut(m, id) {
  const payload = JSON.stringify({ app: 'vibetime', version: SCHEMA, syncedAt: new Date().toISOString(), settings: m.settings, days: m.days, mod: m.mod, settingsMod: m.settingsMod });
  const keepalive = payload.length < 60000;
  if (id) {
    await drive(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive });
  } else {
    const b = 'vt' + Math.random().toString(36).slice(2);
    const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: SYNC_FILE, parents: ['appDataFolder'] })}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${payload}\r\n--${b}--`;
    await drive('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body, keepalive });
  }
}

// ---- the sync itself
let _busy = false, _again = false, _timer = null;
const localPayload = () => ({ settings: state.settings, days: state.days, mod: state.mod || {}, settingsMod: state.settingsMod || 0 });
function applyMerged(m) {
  state.days = m.days; state.mod = m.mod; state.settingsMod = m.settingsMod;
  state.settings = { ...defaults().settings, ...m.settings, theme: state.settings.theme };
  snapshotState(); save(false);
}
// `gesture` is true when this was started by a click, which is the only time the Google sign-in window may open.
async function syncNow(noReload = false, gesture = false) {
  if (!syncConnected() || !syncAvailable()) return;
  if (_busy) { _again = true; return; }
  _busy = true; _gesture = gesture === true; setSyncStatus('syncing');
  let changed = false;
  try {
    const remote = await remoteGet(), local = localPayload();
    const merged = remote ? mergeStates(local, remote.data) : local;
    const m = syncCanon(merged);
    if (!remote || m !== syncCanon(remote.data)) await remotePut(merged, remote && remote.id);
    if (m !== syncCanon(local)) { applyMerged(merged); changed = true; }
    syncWrite({ ...syncInfo(), last: Date.now() });
    setSyncStatus('ok');
  } catch (err) {
    if (err.signin) { setSyncStatus('signin', err.message); if (gesture === true && usingWorker()) setTimeout(() => syncConnect(), 0); }
    else setSyncStatus('error', err.message === 'Failed to fetch' ? 'Couldn’t reach Google Drive. Will try again.' : err.message);
  } finally {
    _busy = false; _gesture = false;
    if (_again) { _again = false; vtSyncSoon(); }
  }
  if (changed) {
    const a = document.activeElement;
    const typing = a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.value && !a.disabled && a.type !== 'checkbox';
    if (noReload === true) return changed;
    if (!typing) location.reload(); else setSyncStatus('ok', 'Updated from another device. Reload to see it.');
  }
}
function vtSyncSoon() {
  if (!syncConnected() || !syncAvailable()) return;
  clearTimeout(_timer); _timer = setTimeout(syncNow, 2500);
}

// New device: sign in and pull what is already there. Nothing is uploaded unless data was found.
// Browser-only fallback: resolves { ok, msg }. With the Worker the page leaves for Google and finishes in finishRestore().
async function syncRestore() {
  if (usingWorker()) { sessionStorage.setItem('vt.after', 'welcome'); return syncConnect('welcome'); }
  if (!await syncConnect()) return { ok: false, msg: _syncStatus.msg || 'Sign-in didn\u2019t finish.' };
  return finishRestore();
}
async function finishRestore() {
  let found;
  try { found = await remoteGet(); } catch (err) { await syncDisconnect(); return { ok: false, msg: err.message }; }
  if (!found) { await syncDisconnect(); return { ok: false, msg: 'No VibeTime data was found in that Google account. Set up VibeTime instead, then connect Google Drive in Settings.' }; }
  await syncNow(true, true);
  try { localStorage.setItem(WELCOME_KEY, '1'); } catch {}
  return _syncStatus.state === 'error' ? { ok: false, msg: _syncStatus.msg } : { ok: true };
}

// ---- when to sync: on opening a page, after changes (above), when coming back to the tab, and when leaving it
(async () => {
  const after = sessionStorage.getItem('vt.after');
  const back = await handleGoogleRedirect();             // just came back from Google (Worker mode)?
  if (!syncAvailable() || !syncConnected()) { if (back && after) sessionStorage.removeItem('vt.after'); return; }
  if (back) {
    sessionStorage.removeItem('vt.after');
    if (after === 'welcome') {                           // a new device that just signed in: pull everything, then start using it
      const res = await finishRestore();
      if (res.ok) location.href = 'index.html';
      else { sessionStorage.setItem('vt.msg', res.msg); try { localStorage.removeItem(WELCOME_KEY); } catch {} location.href = 'welcome.html'; }
      return;
    }
    await syncNow(false, true);
  } else setTimeout(syncNow, 600);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') syncNow();
    else if (Date.now() - ((syncInfo() || {}).last || 0) > 30000) syncNow();
  });
  window.addEventListener('online', () => syncNow());
})();

// A small chip in the sidebar when sync needs a sign-in (a click there is what allows Google's window to open).
window.addEventListener('vibetime-sync', ev => {
  const chip = document.getElementById('syncchip');
  if (chip) chip.hidden = ev.detail.state !== 'signin';
});
