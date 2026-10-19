// The operator's dashboard: one page, with its style and script inside. It reads nothing from
// elsewhere, and the Content-Security-Policy lets only the style and script carrying the nonce of
// that response run. Room names, Discord names and the like come from anyone, so the script puts
// every such string in as text (textContent), never as markup.
//
// The overview is worked out in the browser from what the API gives (the rooms, what happened in
// the last seven days, the bans), so the numbers on it are those of the last load.
//
// The text is in Japanese, as is the guide for operators. The script is kept free of backticks and
// of dollar-brace, so that it can sit inside this template string as it is.

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #f7f7f8; --panel: #ffffff; --text: #1d1d1f; --muted: #6b6b73; --line: #dcdce1; --axis: #b4b4bd;
  --accent: #3a5bd9; --on-accent: #ffffff; --danger: #c62f2f; --ok: #237a3b; --chip: #ececf1;
  --hover: rgba(58, 91, 217, .08); --selected: rgba(58, 91, 217, .12); --shadow: rgba(0, 0, 0, .12);
  /* The series, one for each kind of thing that happened, in the same color on every chart. */
  --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --s4: #eda100; --s5: #e87ba4;
  /* Status, always with an icon and a word beside it. */
  --good: #0ca30c; --warning: #fab219; --critical: #d03b3b;
  font-family: system-ui, -apple-system, 'Segoe UI', 'Hiragino Sans', 'Noto Sans JP', sans-serif;
  font-size: 14px;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #16161a; --panel: #1f1f24; --text: #ececf1; --muted: #a0a0ab; --line: #34343c; --axis: #4a4a54;
    --accent: #8ea6ff; --on-accent: #16161a; --danger: #ff8080; --ok: #6fd68b; --chip: #2c2c33;
    --hover: rgba(142, 166, 255, .10); --selected: rgba(142, 166, 255, .16); --shadow: rgba(0, 0, 0, .5);
    --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500; --s5: #d55181; }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; background: var(--bg); color: var(--text); }
section.panel, .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
.signin { max-width: 480px; margin: 48px auto; }
.signin h1 { font-size: 18px; margin: 0 0 4px; }
.signin .host-name { color: var(--muted); display: block; margin-bottom: 20px; }
.signin label { display: block; margin-bottom: 8px; font-weight: 600; }
.signin input { width: 100%; }
.signin #passkey-register-block label { display: block; font-weight: 600; margin-bottom: 6px; }
a.button { display: inline-block; text-decoration: none; border-radius: 6px; padding: 8px 14px; border: 1px solid var(--line);
  background: var(--chip); color: var(--text); }
a.button.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.card h2 { font-size: 15px; margin: 0 0 8px; }
.card .add-passkey { margin: 12px 0 0; }
.sidebar-foot #operator { padding: 0 6px; font-size: 12px; word-break: break-all; }

/* The frame: the menu on the left, and the page beside it */
.shell { display: grid; grid-template-columns: 232px minmax(0, 1fr); min-height: 100vh; }
.sidebar { position: sticky; top: 0; height: 100vh; overflow-y: auto; display: flex; flex-direction: column; gap: 16px;
  padding: 16px 12px; background: var(--panel); border-right: 1px solid var(--line); }
.brand { padding: 4px 10px; }
.brand strong { display: block; font-size: 15px; }
.brand .host-name { display: block; color: var(--muted); font-size: 12px; word-break: break-all; margin-top: 2px; }
.menu { display: flex; flex-direction: column; gap: 2px; }
.menu [role='tab'] { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; background: transparent;
  border: 0; border-radius: 6px; padding: 8px 10px; color: var(--text); }
.menu [role='tab']:hover { background: var(--hover); }
.menu [role='tab'][aria-selected='true'] { background: var(--selected); color: var(--accent); font-weight: 600; }
.menu svg { width: 18px; height: 18px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.8;
  stroke-linecap: round; stroke-linejoin: round; }
.menu .count { margin-left: auto; color: var(--muted); font-size: 12px; font-weight: 400; font-variant-numeric: tabular-nums; }
.menu .flag { margin-left: auto; display: inline-grid; place-items: center; width: 16px; height: 16px; border-radius: 50%;
  background: var(--warning); color: #1d1d1f; font-size: 11px; font-weight: 700; }
.sidebar-foot { margin-top: auto; display: grid; gap: 8px; padding: 0 4px; }
.content { min-width: 0; display: flex; flex-direction: column; }
.topbar { position: sticky; top: 0; z-index: 3; display: flex; align-items: center; gap: 8px 16px; flex-wrap: wrap;
  padding: 10px 24px; min-height: 56px; background: var(--panel); border-bottom: 1px solid var(--line); }
.topbar h1 { font-size: 18px; margin: 0; }
.topbar .spacer { flex: 1; }
.topbar label { display: inline-flex; align-items: center; gap: 4px; color: var(--muted); }
#menu-open { display: none; }
.scrim { display: none; }
main { padding: 20px 24px 32px; width: 100%; max-width: 1440px; }
@media (max-width: 860px) {
  .shell { grid-template-columns: minmax(0, 1fr); }
  .sidebar { position: fixed; left: 0; top: 0; bottom: 0; width: 248px; z-index: 6; transform: translateX(-100%);
    transition: transform .2s; visibility: hidden; }
  .shell.menu-open .sidebar { transform: none; visibility: visible; box-shadow: 0 0 24px var(--shadow); }
  .shell.menu-open .scrim { display: block; position: fixed; inset: 0; z-index: 5; background: rgba(0, 0, 0, .35); }
  #menu-open { display: inline-flex; }
  .topbar { padding: 8px 16px; }
  .topbar #loaded { display: none; }
  main { padding: 16px; }
}
input, select, button { font: inherit; color: inherit; }
input, select { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; }
button { background: var(--chip); border: 1px solid var(--line); border-radius: 6px; padding: 5px 10px; cursor: pointer; }
button:hover { border-color: var(--accent); }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
button.danger { color: var(--danger); }
button.link { background: none; border: 0; padding: 0; color: var(--accent); text-decoration: underline; }
button:disabled { opacity: .5; cursor: default; }
.status { margin: 0 0 12px; color: var(--muted); }
.status:empty { display: none; }
.status.error, .error { color: var(--danger); }
.status.ok { color: var(--ok); }
.toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
.toolbar input[type='search'] { min-width: min(280px, 100%); }
.toolbar label { display: inline-flex; align-items: center; gap: 4px; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; word-break: keep-all; }
.nowrap { white-space: nowrap; }
th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }
td.num { white-space: nowrap; }
td.actions { white-space: normal; min-width: 13em; }
td.actions:empty { min-width: 0; padding: 0; }
td.actions button, td.actions .chip { margin: 0 2px 2px 0; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.muted { color: var(--muted); }
.chip { display: inline-block; padding: 1px 6px; border-radius: 10px; background: var(--chip); font-size: 12px; white-space: nowrap; }
.chip.refused, .chip.limited, .chip.banned, .chip.critical { color: var(--danger); }
.chip.admin { color: var(--accent); }
.chip .swatch { margin-right: 4px; vertical-align: -1px; }
form.ban { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px 12px; align-items: end; margin-bottom: 8px; }
form.ban label { display: flex; flex-direction: column; gap: 4px; font-weight: 600; }
form.ban .wide { grid-column: span 2; }
.hint { color: var(--muted); margin: 4px 0 0; }
.card + .card { margin-top: 16px; }
dialog { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--text); max-width: min(1000px, 95vw); width: 100%; }
dialog::backdrop { background: rgba(0, 0, 0, .4); }
dialog .head { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 8px; }
dialog h2 { font-size: 15px; margin: 0; }
.empty { color: var(--muted); padding: 12px 8px; margin: 0; }
.loading main { opacity: .6; transition: opacity .2s; }

/* The overview */
.segmented { display: inline-flex; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
.segmented button { border: 0; border-radius: 0; background: transparent; }
.segmented button + button { border-left: 1px solid var(--line); }
.segmented button[aria-pressed='true'] { background: var(--accent); color: var(--on-accent); }
.alerts { display: grid; gap: 6px; margin-bottom: 16px; }
.alert { display: flex; gap: 8px; align-items: baseline; padding: 8px 10px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; }
.alert-icon { display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; flex: none;
  font-size: 12px; font-weight: 700; color: #ffffff; align-self: center; }
.good .alert-icon, .good.badge .alert-icon { background: var(--good); }
.warning .alert-icon { background: var(--warning); color: #1d1d1f; }
.critical .alert-icon { background: var(--critical); }
.alert-label { font-weight: 600; flex: none; }
.alert .badge { flex: none; }
.alert > span:last-child { min-width: 0; }
.badge { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 600; color: var(--text); }
.badge .alert-icon { width: 16px; height: 16px; font-size: 11px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(140px, 100%), 1fr)); gap: 12px; margin-bottom: 16px; }
.tile { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; min-width: 0; }
.tile-label { color: var(--muted); display: flex; gap: 8px; align-items: center; justify-content: space-between; }
.tile-value { font-size: 28px; font-weight: 600; margin: 4px 0 2px; line-height: 1.2; }
.tile-sub { color: var(--muted); font-size: 12px; }
.charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(290px, 100%), 1fr)); gap: 12px; margin-bottom: 16px; }
figure.chart { margin: 0; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; min-width: 0; }
figure.chart figcaption { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; margin-bottom: 8px; }
.chart-title { font-weight: 600; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; }
.key { display: inline-flex; align-items: center; gap: 4px; }
.key .muted { margin-left: 2px; }
.s1 { --c: var(--s1); } .s2 { --c: var(--s2); } .s3 { --c: var(--s3); } .s4 { --c: var(--s4); } .s5 { --c: var(--s5); }
.swatch { width: 10px; height: 10px; border-radius: 3px; display: inline-block; flex: none; background: var(--c); }
.line-key { width: 12px; height: 2px; border-radius: 1px; display: inline-block; flex: none; background: var(--c); }
.plot { position: relative; min-height: 180px; }
.plot svg { display: block; width: 100%; height: auto; overflow: visible; }
.plot .grid { stroke: var(--line); stroke-width: 1; shape-rendering: crispEdges; }
.plot .axis { stroke: var(--axis); stroke-width: 1; shape-rendering: crispEdges; }
.plot .tick { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.plot .hit { fill: transparent; outline: none; }
.plot .hit:hover, .plot .hit:focus, .plot .hit.on { fill: var(--hover); }
.plot .bar { fill: var(--c); pointer-events: none; }
.tip { position: absolute; top: 0; left: 0; z-index: 2; pointer-events: none; background: var(--panel); color: var(--text);
  border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; box-shadow: 0 4px 16px var(--shadow);
  font-size: 12px; min-width: 150px; }
.tip-title { color: var(--muted); margin-bottom: 4px; white-space: nowrap; }
.tip-row { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
.tip-row strong { margin-left: auto; padding-left: 12px; font-variant-numeric: tabular-nums; }
.tip-row span { color: var(--muted); }
.tip-total { border-top: 1px solid var(--line); margin-top: 4px; padding-top: 4px; }
figure.chart details { margin-top: 6px; }
figure.chart summary { cursor: pointer; color: var(--muted); font-size: 12px; }
figure.chart .note { color: var(--muted); font-size: 12px; margin: 6px 0 0; }
.tops { display: grid; gap: 12px; margin-bottom: 12px; }
.block td:first-child { min-width: 9em; }
.block { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; min-width: 0; }
.block h2 { font-size: 14px; margin: 0; }
.block-head { display: flex; gap: 8px 16px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
.block-head .spacer { flex: 1; }
.block .more { margin-top: 8px; }
.order { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
td.pick, th.pick { width: 1%; padding-right: 0; }
.toolbar .spacer { flex: 1; }
dialog section + section { margin-top: 16px; }
dialog h3 { font-size: 14px; margin: 0 0 8px; }
.summary { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-bottom: 8px; }
form.ban .check { flex-direction: row; align-items: center; font-weight: 400; grid-column: 1 / -1; }

/* What was uploaded, accounts, stopping and the settings */
.pause-banner { margin-bottom: 12px; border-color: var(--critical); align-items: center; flex-wrap: wrap; }
.pause-banner button { margin-left: auto; }
.pause-banner.warning { border-color: var(--warning); }
.tighten-kinds { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(16em, 100%), 1fr)); gap: 8px 16px; margin: 12px 0 4px;
  align-items: end; }
.tighten-kinds label { display: flex; flex-direction: column; gap: 4px; }
.pause-kinds { display: flex; flex-wrap: wrap; gap: 8px 20px; margin: 12px 0 4px; }
.pause-kinds label { display: inline-flex; align-items: center; gap: 6px; }
.card .more { margin-top: 8px; }
.card .hint + .scroll, .card h2 + .scroll { margin-top: 8px; }
.account-actions { margin: 12px 0 0; }
#asset-body { display: grid; gap: 8px; justify-items: start; margin-bottom: 4px; }
#asset-body p { margin: 0; }
#asset-body audio { width: 100%; }
img.preview { display: block; max-width: 100%; max-height: 70vh; border: 1px solid var(--line); border-radius: 4px;
  background: repeating-conic-gradient(var(--chip) 0 25%, var(--panel) 0 50%) 0 0 / 16px 16px; }
table.settings td div + div { margin-top: 2px; }
table.settings td { overflow-wrap: anywhere; }
#settings-body, #account-result { margin-top: 8px; }
#account-id { width: 24ch; max-width: 100%; }
.key { display: inline-block; width: 16ch; overflow-wrap: anywhere; word-break: break-all; vertical-align: top; }
.long { overflow-wrap: anywhere; word-break: break-all; }
table.facts th { width: 12em; color: var(--muted); font-weight: 600; }
#asset-facts, #room-meta { margin-bottom: 12px; }
td.wrap { min-width: 6em; overflow-wrap: anywhere; }
th { vertical-align: bottom; }
td.num.error { color: var(--danger); }
`;

const SCRIPT = `
'use strict';
(function () {
  var PREFS_KEY = 'axe-admin-prefs';
  var REFRESH_MS = 30000;
  var MAX_ACTIVITY = 2000;
  var MAX_ROOMS = 2000;
  var TOP_ROWS = 10;
  var HOUR_MS = 60 * 60 * 1000;
  var GAP = 2;
  var base = location.pathname.replace(/\\/*$/, '/');
  /** Who is logged in, as the server last said (the answer to GET session). */
  var me = null;
  /** What is stopped now, as the server last said. */
  var pauseState = null;
  /** How tight the rate limits are now, as the server last said. */
  var tightenState = null;
  /** The store's size as the daily count last found it, and the amount past which the operator is told. */
  var storageState = { usage: null, limitBytes: null, roomLimitBytes: null };
  /** Every asset in the store as last read (on the uploads tab), and the barred ones. */
  var uploads = null;
  var uploadsLoading = false;
  var uploadsShown = 200;
  /** The object URL of the asset being looked at, let go when the preview closes. */
  var previewUrl = null;
  var data = { rooms: [], bans: [], activity: [] };
  var banIndex = { ranges: [], accounts: {} };
  var loading = false;
  var timer = null;
  var showAll = { senders: false, accounts: false, assets: false };
  /** The rooms ticked to be deleted together, by key. */
  var picked = {};

  var KIND_LABELS = {
    login: 'ログイン',
    room: '部屋を作った',
    upload: '画像と音声を置いた',
    limited: '回数の制限',
    refused: 'BANで断った',
    admin: '管理'
  };
  /** The kinds drawn on the overview, each in the series color it keeps on every chart and chip. */
  var SERIES = { login: 1, room: 2, upload: 3, limited: 4, refused: 5 };
  var LIMIT_LABELS = { upload: '画像と音声を置く', read: '読み出し', room: '部屋を作る・入る', auth: 'ログイン' };
  var ROLE_LABELS = { gm: 'GM', pl: 'PL', guest: '見学' };
  var RANGE_LABELS = { day: '24時間', week: '7日' };
  var STATUS = {
    good: { icon: '✓', label: 'OK' },
    warning: { icon: '!', label: '注意' },
    critical: { icon: '!', label: '要対応' }
  };
  var TABS = ['overview', 'rooms', 'uploads', 'activity', 'bans', 'accounts', 'security', 'settings'];
  var TITLES = {
    overview: '概要', rooms: '部屋', uploads: 'アップロード', activity: '記録', bans: 'BAN',
    accounts: 'アカウント', security: '安全', settings: '設定'
  };
  /** How many pages of the store the uploads tab reads at most. */
  var MAX_INVENTORY_PAGES = 50;
  /** What the operator can stop everyone from doing for a while. */
  var PAUSE_LABELS = { rooms: '部屋を作る', uploads: '画像と音声を置く', logins: '新しくログインする' };
  var PAUSE_KINDS = ['rooms', 'uploads', 'logins'];
  /** The rate limits the operator can tighten for a while. */
  var TIGHTEN_KINDS = ['upload', 'read', 'room', 'auth'];
  /** Why the way back from Discord turned the operator away. */
  var DENIED = {
    'not-allowed': 'このDiscordのアカウントは、管理画面に入れる人（ADMIN_DISCORD_IDS）にありません。',
    'mfa-required': 'Discordの2段階認証を有効にしてから、ログインし直してください。',
    state: 'ログインをやり直してください（時間が経ちすぎたか、別のブラウザで始めたログインです）。',
    cancelled: 'Discordでのログインが取り消されました。',
    discord: 'Discordとのやりとりがうまくいきませんでした。少し待ってからやり直してください。',
    'rate-limited': '試す回数が多すぎます。1分ほど待ってから、もう一度試してください。',
    'login-unavailable': 'ログイン（Discord）が設定されていないので、管理画面は使えません。'
  };

  function $(id) { return document.getElementById(id); }


  /** What the operator chose on this tab (the tab shown, the period, reloading, the order). */
  var prefs = (function () {
    var kept = {};
    try { kept = JSON.parse(sessionStorage.getItem(PREFS_KEY) || '{}') || {}; } catch (e) { kept = {}; }
    return {
      tab: TABS.indexOf(kept.tab) >= 0 ? kept.tab : 'overview',
      range: kept.range === 'week' ? 'week' : 'day',
      auto: kept.auto === true,
      order: ['bytes', 'room', 'blocked', 'total'].indexOf(kept.order) >= 0 ? kept.order : 'bytes'
    };
  })();
  function savePrefs() {
    try { sessionStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* Not kept. */ }
  }

  /** Makes an element. Strings go in as text, never as markup. */
  function h(tag, props) {
    var el = document.createElement(tag);
    setProps(el, props);
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  /** Makes an SVG element, the same way. */
  function s(tag, props) {
    var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    setProps(el, props);
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function setProps(el, props) {
    var attrs = props || {};
    Object.keys(attrs).forEach(function (name) {
      var value = attrs[name];
      if (value === undefined || value === null || value === false) return;
      if (name.slice(0, 2) === 'on') el.addEventListener(name.slice(2), value);
      else el.setAttribute(name === 'className' ? 'class' : name, value === true ? '' : String(value));
    });
  }
  function append(el, child) {
    if (child === undefined || child === null || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (each) { append(el, each); }); return; }
    el.append(child instanceof Node ? child : String(child));
  }

  function ApiError(status, code) { this.status = status; this.code = code; }

  /**
   * Calls the dashboard's API. The session goes in its HttpOnly cookie, which no script reads; the
   * header tells the server the call comes from this page. When what is asked cannot be undone and
   * the passkey confirmed the session a while ago, the passkey is asked for again, and the call made
   * once more.
   */
  function api(method, path, body, again) {
    var headers = { 'X-Admin-Request': '1' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(base + 'api/' + path, {
      method: method,
      headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store'
    }).then(function (res) {
      if (res.status === 204) return null;
      return res.json().catch(function () { return {}; }).then(function (json) {
        if (!res.ok) throw new ApiError(res.status, (json && json.error) || 'unknown');
        return json;
      });
    }).catch(function (err) {
      if (!again && err instanceof ApiError && err.code === 'reauth-required') {
        setStatus('続けるには、パスキーでもう一度確かめてください。');
        return confirmPasskey().then(function () { setStatus(''); return api(method, path, body, true); });
      }
      // A session that ran out (not the first visit, before any) goes back to the way in.
      if (me && err instanceof ApiError && err.status === 401 && path !== 'passkeys/verify') {
        signedOut('ログインが切れました。もう一度ログインしてください。');
      }
      throw err;
    });
  }

  function messageOf(err) {
    if (err instanceof PasskeyError) return err.message;
    if (!(err instanceof ApiError)) return '部屋のサーバーにつながりませんでした。';
    switch (err.code) {
      case 'passkey-refused': return 'パスキーで確かめられませんでした。';
      case 'passkey-exists': return 'このパスキーは、もう登録してあります。';
      case 'too-many-passkeys': return 'パスキーは10個までです。使わないものを消してください。';
      case 'last-passkey': return '最後のパスキーは消せません。先に別の端末のパスキーを登録してください。';
      case 'invalid-challenge': return 'やりとりの時間が切れました。もう一度試してください。';
      case 'reauth-required': return 'パスキーでもう一度確かめてください。';
    }
    switch (err.status) {
      case 401: return 'ログインが切れました。もう一度ログインしてください。';
      case 429: return '試す回数が多すぎます。1分ほど待ってから、もう一度試してください。';
      case 503: return 'ログイン（Discord）が設定されていないので、部屋のサーバーは動いていません。';
      case 400: return '入力の形が違います。';
      case 404: return '見つかりませんでした（もう無いのかもしれません）。';
      default: return 'うまくいきませんでした（' + err.status + ' ' + err.code + '）。';
    }
  }

  function setStatus(text, kind) {
    var status = $('status');
    status.textContent = text || '';
    status.className = 'status' + (kind ? ' ' + kind : '');
  }

  // ---- Passkeys ----

  /** A refusal from the browser or the device, said in words for the operator. */
  function PasskeyError(message) { this.message = message; }

  function bytesOf(text) {
    var padded = text.split('-').join('+').split('_').join('/');
    while (padded.length % 4) padded += '=';
    var binary = atob(padded);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  function textOf(buffer) {
    var bytes = new Uint8Array(buffer);
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).split('+').join('-').split('/').join('_').split('=').join('');
  }
  function credentialsOf(list) {
    return list.map(function (each) { return { type: each.type, id: bytesOf(each.id) }; });
  }

  /** What the browser or the device said, in words. */
  function refusalOf(err) {
    if (err instanceof ApiError || err instanceof PasskeyError) return err;
    if (err && err.name === 'NotAllowedError') return new PasskeyError('パスキーの操作が取り消されたか、時間が切れました。');
    if (err && err.name === 'InvalidStateError') return new PasskeyError('この端末のパスキーは、もう登録してあります。');
    return new PasskeyError('パスキーを使えませんでした（' + ((err && err.name) || 'error') + '）。');
  }

  function passkeysUsable() {
    if (window.PublicKeyCredential && navigator.credentials) return Promise.resolve();
    return Promise.reject(new PasskeyError('このブラウザでは、パスキーを使えません。'));
  }

  /** Makes a passkey on this device and registers it. It also confirms the session. */
  function registerPasskey(name) {
    return passkeysUsable().then(function () { return api('POST', 'passkeys/options'); }).then(function (res) {
      var options = res.options;
      return navigator.credentials.create({
        publicKey: {
          challenge: bytesOf(options.challenge),
          rp: options.rp,
          user: { id: bytesOf(options.user.id), name: options.user.name, displayName: options.user.displayName },
          pubKeyCredParams: options.pubKeyCredParams,
          excludeCredentials: credentialsOf(options.excludeCredentials),
          authenticatorSelection: options.authenticatorSelection,
          attestation: options.attestation,
          timeout: options.timeout
        }
      }).then(function (credential) {
        var response = credential.response;
        var publicKey = typeof response.getPublicKey === 'function' ? response.getPublicKey() : null;
        if (!publicKey) throw new PasskeyError('このブラウザでは、パスキーを登録できません（新しいブラウザで試してください）。');
        return api('POST', 'passkeys', {
          token: res.token,
          name: name,
          credential: {
            id: credential.id,
            clientDataJSON: textOf(response.clientDataJSON),
            authenticatorData: textOf(response.getAuthenticatorData()),
            publicKey: textOf(publicKey),
            algorithm: response.getPublicKeyAlgorithm()
          }
        });
      });
    }).catch(function (err) { throw refusalOf(err); });
  }

  /** Has one of the operator's passkeys sign a challenge, which confirms the session. */
  function confirmPasskey() {
    return passkeysUsable().then(function () { return api('POST', 'passkeys/challenge', undefined, true); }).then(function (res) {
      var options = res.options;
      return navigator.credentials.get({
        publicKey: {
          challenge: bytesOf(options.challenge),
          rpId: options.rpId,
          allowCredentials: credentialsOf(options.allowCredentials),
          userVerification: options.userVerification,
          timeout: options.timeout
        }
      }).then(function (credential) {
        var response = credential.response;
        return api('POST', 'passkeys/verify', {
          token: res.token,
          credential: {
            id: credential.id,
            clientDataJSON: textOf(response.clientDataJSON),
            authenticatorData: textOf(response.authenticatorData),
            signature: textOf(response.signature)
          }
        }, true);
      });
    }).catch(function (err) { throw refusalOf(err); });
  }

  // ---- Numbers and times ----

  var NUMBER = new Intl.NumberFormat('ja-JP');
  function count(n) { return NUMBER.format(n); }
  /** A size in GB, as ADMIN_STORAGE_ALERT_GB is written. */
  function gb(bytes) { return (bytes / 1e9).toFixed(2) + ' GB'; }
  /** Whether the store, as last counted, is past the amount set. */
  function storageOver() {
    return storageState.limitBytes !== null && storageState.usage !== null && storageState.usage.bytes > storageState.limitBytes;
  }
  function sum(values) { return values.reduce(function (total, value) { return total + value; }, 0); }
  function distinct(values) {
    var seen = {};
    values.forEach(function (value) { if (value) seen[value] = true; });
    return Object.keys(seen).length;
  }
  function time(ms) {
    if (ms === null || ms === undefined) return '';
    return new Date(ms).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'medium' });
  }
  function size(bytes) {
    var n = Number(bytes);
    if (!isFinite(n)) return String(bytes);
    if (n < 1024) return n + 'B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KiB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + 'MiB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + 'GiB';
  }
  function dayOf(ms) {
    var d = new Date(ms);
    return (d.getMonth() + 1) + '/' + d.getDate() + '（' + '日月火水木金土'.charAt(d.getDay()) + '）';
  }
  function hourOf(ms) { return new Date(ms).getHours() + ':00'; }
  /** A room key or a SHA-256, whole, folded inside its column so that it can be read and copied. */
  function keyText(key) { return key ? h('span', { className: 'mono key' }, key) : h('span', { className: 'muted' }, '—'); }
  function mono(text) { return text ? h('span', { className: 'mono' }, text) : h('span', { className: 'muted' }, '—'); }
  function roomName(roomKey) {
    for (var i = 0; i < data.rooms.length; i++) if (data.rooms[i].roomKey === roomKey) return data.rooms[i].name;
    return null;
  }
  /** The names the record knows each Discord account by, for entries written without one. */
  function namesById() {
    var names = {};
    data.activity.forEach(function (entry) { if (entry.discordId && entry.name && !names[entry.discordId]) names[entry.discordId] = entry.name; });
    return names;
  }
  function uploadBytes(entry) {
    var n = Number(String(entry.detail || '').split(' ')[1]);
    return isFinite(n) ? n : 0;
  }

  // ---- Addresses, to tell whether one is under a ban ----

  function parseV4(text) {
    var parts = text.split('.');
    if (parts.length !== 4) return null;
    var bits = 0n;
    for (var i = 0; i < 4; i++) {
      if (!/^[0-9]{1,3}$/.test(parts[i]) || Number(parts[i]) > 255) return null;
      bits = (bits << 8n) | BigInt(Number(parts[i]));
    }
    return { v: 4, bits: bits };
  }
  /** An IP address as the room server reads it: IPv4 inside IPv6 is IPv4. Null when it is none. */
  function parseAddress(text) {
    var value = String(text || '').trim();
    var zone = value.indexOf('%');
    if (zone >= 0) value = value.slice(0, zone);
    if (value.indexOf(':') < 0) return parseV4(value);
    var tail = null;
    var last = value.lastIndexOf(':');
    if (value.slice(last + 1).indexOf('.') >= 0) {
      tail = parseV4(value.slice(last + 1));
      if (!tail) return null;
      value = value.slice(0, last + 1) + '0:0';
    }
    var halves = value.split('::');
    if (halves.length > 2) return null;
    var head = halves[0] ? halves[0].split(':') : [];
    var rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    var missing = 8 - head.length - rest.length;
    if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
    var groups = head.concat(new Array(missing).fill('0'), rest);
    var bits = 0n;
    for (var i = 0; i < 8; i++) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(groups[i])) return null;
      bits = (bits << 16n) | BigInt(parseInt(groups[i], 16));
    }
    if (tail) bits = ((bits >> 32n) << 32n) | tail.bits;
    if ((bits >> 32n) === 0xffffn) return { v: 4, bits: bits & 0xffffffffn };
    return { v: 6, bits: bits };
  }
  /** A range as the room server keeps it (203.0.113.0/24), ready to be matched. Null when it is none. */
  function rangeOf(text) {
    var slash = text.indexOf('/');
    var net = slash > 0 ? parseAddress(text.slice(0, slash)) : null;
    if (!net) return null;
    var shift = BigInt((net.v === 4 ? 32 : 128) - Number(text.slice(slash + 1)));
    return { v: net.v, shift: shift, prefix: net.bits >> shift };
  }
  function inRange(range, address) {
    var parsed = parseAddress(address);
    return !!parsed && range.v === parsed.v && (parsed.bits >> range.shift) === range.prefix;
  }
  /** Reads the bans once for each load, ready to be matched against many addresses. */
  function indexBans() {
    var now = Date.now();
    banIndex = { ranges: [], accounts: {} };
    data.bans.forEach(function (ban) {
      if (ban.expiresAt !== null && ban.expiresAt <= now) return;
      if (ban.kind === 'discord') { banIndex.accounts[ban.value] = true; return; }
      var range = rangeOf(ban.value);
      if (range) banIndex.ranges.push(range);
    });
  }
  function addressBanned(address) {
    return banIndex.ranges.some(function (range) { return inRange(range, address); });
  }
  /** The rooms that the target of a ban made (those whose maker is known). */
  function roomsMadeBy(kind, value) {
    var range = kind === 'ip' ? rangeOf(value.indexOf('/') > 0 ? value : value + (value.indexOf(':') >= 0 ? '/64' : '/32')) : null;
    return data.rooms.filter(function (room) {
      if (!room.creator) return false;
      return kind === 'discord' ? room.creator.discordId === value : !!range && inRange(range, room.creator.address);
    });
  }
  function accountBanned(discordId) { return !!discordId && banIndex.accounts[discordId] === true; }

  // ---- Banning ----

  function targetOf(kind, value) { return (kind === 'ip' ? 'IPアドレス「' : 'Discord ID「') + value + '」'; }

  /** Fills in the form to ban, and goes to it. Nothing is banned until the operator presses the button. */
  function prepareBan(kind, value, reason, replacing) {
    $('ban-kind').value = kind;
    $('ban-value').value = value;
    $('ban-reason').value = reason || '';
    $('ban-rooms').checked = false;
    if ($('room-dialog').open) $('room-dialog').close();
    show('bans');
    if (replacing) {
      $('ban-hours').focus();
      setStatus(targetOf(kind, value) + 'のBANを変えます。期間と理由を選び直して「BANする」を押すと、いまのBANと置き換わります（期間は押したときから数えます）。');
      return;
    }
    $('ban-reason').focus();
    setStatus(targetOf(kind, value) + 'をBANする用意をしました。期間と理由を確かめて、「BANする」を押してください。');
  }
  /** The buttons to ban someone, or a mark where they are banned already. */
  function banButtons(discordId, address, reason) {
    var byAccount = null;
    var byAddress = null;
    if (discordId) {
      byAccount = accountBanned(discordId)
        ? h('span', { className: 'chip banned' }, 'Discord BAN中')
        : h('button', { type: 'button', onclick: function () { prepareBan('discord', discordId, reason); } }, 'Discord BAN');
    }
    if (address && address !== 'unknown') {
      byAddress = addressBanned(address)
        ? h('span', { className: 'chip banned' }, 'IP BAN中')
        : h('button', { type: 'button', onclick: function () { prepareBan('ip', address, reason); } }, 'IP BAN');
    }
    return [byAccount, byAddress];
  }

  function submitBan(event) {
    event.preventDefault();
    var hours = $('ban-hours').value;
    var body = {
      kind: $('ban-kind').value,
      value: $('ban-value').value.trim(),
      reason: $('ban-reason').value.trim(),
      hours: hours ? Number(hours) : null
    };
    var withRooms = $('ban-rooms').checked;
    var made = withRooms ? roomsMadeBy(body.kind, body.value) : [];
    if (withRooms && made.length > 0 &&
      !confirm(targetOf(body.kind, body.value) + 'をBANし、この対象が作った部屋' + made.length + '件も削除しますか。入っている人の接続は切れ、卓と画像と音声はすべて消えます。')) return;
    var button = $('ban-submit');
    button.disabled = true;
    api('POST', 'bans', body).then(function (res) {
      $('ban-value').value = '';
      $('ban-reason').value = '';
      $('ban-rooms').checked = false;
      var done = targetOf(res.ban.kind, res.ban.value) + 'をBANしました。部屋に入っていた接続も切りました。';
      if (made.length === 0) {
        setStatus(done + (withRooms ? ' この対象が作った部屋はありませんでした。' : ''), 'ok');
        return load();
      }
      return removeRooms(made, done);
    }).catch(function (err) { setStatus(messageOf(err), 'error'); }).then(function () { button.disabled = false; });
  }

  /** Deletes the rooms one after another, saying how far it has got, and reads everything again. */
  function removeRooms(rooms, before) {
    var deleted = 0;
    var failed = 0;
    var prefix = before ? before + ' ' : '';
    var next = Promise.resolve();
    rooms.forEach(function (room, i) {
      next = next.then(function () {
        setStatus(prefix + '部屋を削除しています…（' + (i + 1) + '/' + rooms.length + '）');
        return api('DELETE', 'rooms/' + room.roomKey).then(function () { deleted++; }, function (err) {
          // A room already gone counts as deleted.
          if (err instanceof ApiError && err.status === 404) deleted++; else failed++;
        });
      });
    });
    return next.then(function () {
      rooms.forEach(function (room) { delete picked[room.roomKey]; });
      setStatus(prefix + '部屋を' + deleted + '件削除しました。' + (failed ? 'できなかったものが' + failed + '件あります。' : ''), failed ? 'error' : 'ok');
      return load();
    });
  }

  function liftBan(ban) {
    if (!confirm(targetOf(ban.kind, ban.value) + 'のBANを解きますか。')) return;
    api('DELETE', 'bans?kind=' + encodeURIComponent(ban.kind) + '&value=' + encodeURIComponent(ban.value))
      .then(function () { setStatus(targetOf(ban.kind, ban.value) + 'のBANを解きました。', 'ok'); return load(); })
      .catch(function (err) { setStatus(messageOf(err), 'error'); });
  }

  // ---- The overview ----

  /** The columns of the period: the last 24 hours by the hour, or the last 7 days by the day. */
  function periodOf(range, now) {
    var buckets = [];
    var at = new Date(now);
    if (range === 'week') {
      at.setHours(0, 0, 0, 0);
      for (var day = 6; day >= 0; day--) {
        var start = new Date(at.getFullYear(), at.getMonth(), at.getDate() - day).getTime();
        var end = new Date(at.getFullYear(), at.getMonth(), at.getDate() - day + 1).getTime();
        buckets.push({ start: start, end: end, title: dayOf(start), tick: dayOf(start).replace(/（.）/, '') });
      }
    } else {
      at.setMinutes(0, 0, 0);
      for (var hour = 23; hour >= 0; hour--) {
        var from = at.getTime() - hour * HOUR_MS;
        var clock = new Date(from).getHours();
        buckets.push({
          start: from,
          end: from + HOUR_MS,
          title: dayOf(from) + ' ' + hourOf(from) + '〜' + hourOf(from + HOUR_MS),
          tick: clock % 6 === 0 ? clock + '時' : ''
        });
      }
    }
    return { range: range, buckets: buckets, start: buckets[0].start, end: buckets[buckets.length - 1].end };
  }

  /** What happened in the period, counted for each column. */
  function tally(period) {
    var n = period.buckets.length;
    var counts = {};
    Object.keys(SERIES).forEach(function (kind) { counts[kind] = new Array(n).fill(0); });
    var bytes = new Array(n).fill(0);
    var entries = data.activity.filter(function (entry) { return entry.at >= period.start && entry.at < period.end; });
    entries.forEach(function (entry) {
      var index = n - 1;
      while (index > 0 && entry.at < period.buckets[index].start) index--;
      if (counts[entry.kind]) counts[entry.kind][index]++;
      if (entry.kind === 'upload') bytes[index] += uploadBytes(entry);
    });
    return { counts: counts, bytes: bytes, entries: entries };
  }
  function ofKind(entries, kind) { return entries.filter(function (entry) { return entry.kind === kind; }); }
  /** Whether it is someone turned away from the dashboard (not an operator's own step). */
  function isDenied(entry) { return entry.kind === 'admin' && String(entry.detail || '').indexOf('denied') === 0; }
  /** One of the operators' own steps, kept apart for 90 days. */
  function isOperatorStep(entry) { return entry.kind === 'admin' && !isDenied(entry); }
  function deniedOf(entries) {
    return entries.filter(isDenied);
  }

  function statusMark(status, className) {
    return h('span', { className: className + ' ' + status },
      h('span', { className: 'alert-icon', 'aria-hidden': 'true' }, STATUS[status].icon),
      h('span', { className: 'alert-label' }, STATUS[status].label));
  }

  /** What to warn the operator of in the period, most pressing first. Empty when there is nothing. */
  function alertsOf(tallied, period) {
    var items = [];
    var limited = distinct(ofKind(tallied.entries, 'limited').map(function (entry) { return entry.address; }));
    var guessed = distinct(deniedOf(tallied.entries).map(function (entry) { return entry.address; }));
    if (guessed > 0) {
      items.push(['critical', '管理画面に入ろうとして断られた送信元が' + count(guessed) + '件あります。心当たりが無ければ「記録」で確かめ、「安全」からすべての人をログアウトさせてください。']);
    }
    if (limited > 0) {
      items.push(['warning', '回数の上限を超えた送信元が' + count(limited) + '件あります。下の「目立つ送信元」で確かめてください。']);
    }
    if (storageOver()) {
      items.push(['critical', '画像と音声の置き場所が、知らせる量（' + gb(storageState.limitBytes) + '）を超えています。' + time(storageState.usage.at) +
        'に数えたときに' + gb(storageState.usage.bytes) + 'でした。「アップロード」の「場所を多く使っている部屋」で確かめてください。']);
    }
    // The operators' own steps are kept apart, so only the rest can reach the cap.
    var rest = data.activity.filter(function (entry) { return !isOperatorStep(entry); });
    var oldest = rest.length ? rest[rest.length - 1].at : null;
    if (rest.length >= MAX_ACTIVITY && oldest > period.start) {
      items.push(['warning', '記録が上限の' + count(MAX_ACTIVITY) + '件に達しているので、' + time(oldest) + 'より前の出来事は数えていません。']);
    }
    return items;
  }

  function renderAlerts(tallied, period) {
    var items = alertsOf(tallied, period);
    if (items.length === 0) items.push(['good', 'この' + RANGE_LABELS[period.range] + 'に、気になる動きはありません。']);
    $('alerts').replaceChildren.apply($('alerts'), items.map(function (item) {
      return h('div', { className: 'alert ' + item[0], role: item[0] === 'good' ? null : 'alert' },
        statusMark(item[0], 'badge'), h('span', null, item[1]));
    }));
  }

  function tile(label, value, sub, status) {
    return h('div', { className: 'tile' },
      h('div', { className: 'tile-label' }, h('span', null, label), status ? statusMark(status, 'badge') : null),
      h('div', { className: 'tile-value' }, value),
      h('div', { className: 'tile-sub' }, sub));
  }

  function renderTiles(tallied) {
    var entries = tallied.entries;
    var people = sum(data.rooms.map(function (room) { return room.members; }));
    var occupied = data.rooms.filter(function (room) { return room.members > 0; }).length;
    var uploads = ofKind(entries, 'upload');
    var logins = ofKind(entries, 'login');
    var limited = ofKind(entries, 'limited');
    var refused = ofKind(entries, 'refused');
    var bans = banIndex.ranges.length + Object.keys(banIndex.accounts).length;
    var rooms = count(data.rooms.length) + (data.rooms.length >= MAX_ROOMS ? '+' : '');
    var tiles = $('tiles');
    tiles.replaceChildren();
    append(tiles, [
      tile('いま入っている人', count(people), '人がいる部屋 ' + count(occupied) + '件'),
      tile('部屋', rooms, 'この期間に作られた部屋 ' + count(ofKind(entries, 'room').length) + '件'),
      tile('置いた画像と音声', count(uploads.length), size(sum(tallied.bytes))),
      tile('ログイン', count(logins.length), 'アカウント ' + count(distinct(logins.map(function (entry) { return entry.discordId; }))) + '人'),
      tile('回数の制限', count(limited.length),
        '送信元 ' + count(distinct(limited.map(function (entry) { return entry.address; }))) + '件',
        limited.length > 0 ? 'warning' : null),
      tile('BAN', count(bans), 'この期間に断った ' + count(refused.length) + '回'),
      storageTile()
    ]);
  }

  /** The store's size as last counted, against the amount set. None when the store is not counted. */
  function storageTile() {
    var limit = storageState.limitBytes;
    var usage = storageState.usage;
    if (limit === null) return null;
    if (usage === null) return tile('置き場所', 'まだ', '1日1回、日本時間の3時ごろに数えます');
    var status = usage.bytes > limit ? 'critical' : usage.bytes > limit * 0.8 ? 'warning' : null;
    return tile('置き場所', gb(usage.bytes), '知らせる量 ' + gb(limit) + '・' + time(usage.at) + 'に数えた' + (usage.complete ? '' : '（途中まで）'), status);
  }

  /** A step for the value axis, of 1, 2 or 5 times a power of ten. */
  function niceStep(raw) {
    var power = Math.pow(10, Math.floor(Math.log10(raw)));
    var unit = raw / power;
    return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power;
  }
  /** The scale of the value axis: whole numbers, or bytes in the unit that suits the largest. */
  function axisOf(kind, max) {
    if (kind !== 'bytes') return { divisor: 1, suffix: '', whole: true };
    if (max >= 1024 * 1024 * 1024) return { divisor: 1024 * 1024 * 1024, suffix: 'GiB' };
    if (max >= 1024 * 1024) return { divisor: 1024 * 1024, suffix: 'MiB' };
    if (max >= 1024) return { divisor: 1024, suffix: 'KiB' };
    return { divisor: 1, suffix: 'B', whole: true };
  }
  /** A column whose top corners are rounded and whose foot stands square on the baseline. */
  function roundedTop(x, y, width, height, radius) {
    var r = Math.min(radius, width / 2, height);
    return 'M' + x + ',' + (y + height) + 'V' + (y + r) + 'Q' + x + ',' + y + ' ' + (x + r) + ',' + y +
      'H' + (x + width - r) + 'Q' + (x + width) + ',' + y + ' ' + (x + width) + ',' + (y + r) + 'V' + (y + height) + 'Z';
  }

  /** Stacked columns, one for each part of the period, with a tooltip for each. */
  function drawColumns(plot, period, list, format, axisKind) {
    var width = Math.max(plot.clientWidth, 280);
    var height = 190;
    var m = { top: 10, right: 8, bottom: 24, left: 52 };
    var innerW = width - m.left - m.right;
    var innerH = height - m.top - m.bottom;
    var n = period.buckets.length;
    var totals = period.buckets.map(function (bucket, i) { return sum(list.map(function (one) { return one.values[i]; })); });
    var max = Math.max.apply(null, totals);
    var tip = h('div', { className: 'tip', hidden: true, role: 'tooltip' });
    if (max === 0) {
      plot.replaceChildren(h('p', { className: 'empty' }, 'この' + RANGE_LABELS[period.range] + 'には、ありません。'));
      return;
    }
    var axis = axisOf(axisKind, max);
    var scaled = max / axis.divisor;
    var step = niceStep(axis.whole ? Math.max(scaled / 4, 1) : scaled / 4);
    var steps = Math.ceil(scaled / step);
    var top = steps * step * axis.divisor;
    var y = function (value) { return m.top + innerH - (value / top) * innerH; };
    var root = s('svg', { width: width, height: height, viewBox: '0 0 ' + width + ' ' + height, 'aria-hidden': 'true' });
    for (var k = 0; k <= steps; k++) {
      var at = Math.round(y(k * step * axis.divisor)) + 0.5;
      root.append(s('line', { className: k === 0 ? 'axis' : 'grid', x1: m.left, x2: width - m.right, y1: at, y2: at }));
      var label = Number((k * step).toFixed(2)).toLocaleString('ja-JP') + (k === 0 ? '' : axis.suffix);
      root.append(s('text', { className: 'tick', x: m.left - 6, y: at + 4, 'text-anchor': 'end' }, label));
    }
    var band = innerW / n;
    var barW = Math.min(24, Math.max(3, band * 0.62));
    var hits = [];
    period.buckets.forEach(function (bucket, i) {
      var x = m.left + i * band + (band - barW) / 2;
      var hit = s('rect', { className: 'hit', x: m.left + i * band, y: m.top, width: band, height: innerH, tabindex: 0,
        'aria-label': bucket.title + ' ' + format(totals[i]) });
      var open = function () {
        hits.forEach(function (other) { other.classList.toggle('on', other === hit); });
        showTip(plot, tip, m.left + (i + 0.5) * band, bucket, list, i, format);
      };
      var close = function () { hit.classList.remove('on'); tip.hidden = true; };
      hit.addEventListener('pointerenter', open);
      hit.addEventListener('focus', open);
      hit.addEventListener('click', open);
      hit.addEventListener('pointerleave', close);
      hit.addEventListener('blur', close);
      hits.push(hit);
      root.append(hit);
      var parts = list.filter(function (one) { return one.values[i] > 0; });
      var below = 0;
      parts.forEach(function (one, index) {
        var foot = y(below);
        below += one.values[i];
        var head = y(below);
        var full = foot - head;
        var className = 'bar s' + one.series;
        if (index === parts.length - 1) {
          root.append(s('path', { className: className, d: roundedTop(x, head, barW, Math.max(full, 1), 4) }));
        } else {
          // A gap of surface above every part but the top one keeps the parts apart.
          var room = full > GAP + 1 ? GAP : 0;
          root.append(s('rect', { className: className, x: x, y: head + room, width: barW, height: Math.max(full - room, 1) }));
        }
      });
      if (bucket.tick) {
        root.append(s('text', { className: 'tick', x: m.left + (i + 0.5) * band, y: height - 6, 'text-anchor': 'middle' }, bucket.tick));
      }
    });
    plot.replaceChildren(root, tip);
  }

  function showTip(plot, tip, center, bucket, list, i, format) {
    var rows = list.map(function (one) {
      return h('div', { className: 'tip-row' }, h('i', { className: 'line-key s' + one.series }), h('span', null, one.label),
        h('strong', null, format(one.values[i])));
    });
    var total = list.length > 1
      ? h('div', { className: 'tip-row tip-total' }, h('span', null, '合計'),
        h('strong', null, format(sum(list.map(function (one) { return one.values[i]; })))))
      : null;
    tip.replaceChildren();
    append(tip, [h('div', { className: 'tip-title' }, bucket.title), rows, total]);
    tip.hidden = false;
    var left = Math.min(Math.max(center - tip.offsetWidth / 2, 0), plot.clientWidth - tip.offsetWidth);
    tip.style.transform = 'translate(' + Math.round(left) + 'px, 0)';
  }

  /** A chart in its figure: the legend (for two or more series), the columns, and the numbers as a table. */
  function chart(id, period, list, format, axisKind) {
    var figure = $(id);
    var legend = figure.querySelector('.legend');
    if (list.length > 1) {
      legend.replaceChildren.apply(legend, list.map(function (one) {
        return h('span', { className: 'key' }, h('i', { className: 'swatch s' + one.series }), one.label,
          h('span', { className: 'muted' }, format(sum(one.values))));
      }));
    } else {
      legend.replaceChildren(h('span', { className: 'muted' }, '合計 ' + format(sum(list[0].values))));
    }
    drawColumns(figure.querySelector('.plot'), period, list, format, axisKind);
    figure.querySelector('.table-view').replaceChildren(h('table', null,
      h('thead', null, h('tr', null, h('th', null, period.range === 'week' ? '日' : '時刻'),
        list.map(function (one) { return h('th', { className: 'num' }, one.label); }))),
      h('tbody', null, period.buckets.map(function (bucket, i) {
        return h('tr', null, h('td', null, bucket.title),
          list.map(function (one) { return h('td', { className: 'num' }, format(one.values[i])); }));
      }))));
  }
  function seriesOf(tallied, kind) {
    return { series: SERIES[kind], label: KIND_LABELS[kind], values: tallied.counts[kind] };
  }

  var ORDERS = {
    bytes: function (row) { return [row.bytes, row.room, row.limited + row.refused, row.total]; },
    room: function (row) { return [row.room, row.bytes, row.total]; },
    blocked: function (row) { return [row.wrongKey + row.limited + row.refused, row.total]; },
    total: function (row) { return [row.total, row.bytes]; }
  };
  function byOrder(a, b) {
    var left = ORDERS[prefs.order](a);
    var right = ORDERS[prefs.order](b);
    for (var i = 0; i < left.length; i++) if (left[i] !== right[i]) return right[i] - left[i];
    return b.last - a.last;
  }

  /** Who did what in the period, one row for each sender or account. The operator's own steps are left out. */
  function rowsBy(entries, keyOf) {
    var rows = {};
    entries.forEach(function (entry) {
      if (entry.kind === 'admin' && !isDenied(entry)) return;
      var key = keyOf(entry);
      if (!key) return;
      var row = rows[key];
      if (!row) {
        row = rows[key] = { key: key, name: null, room: 0, upload: 0, bytes: 0, login: 0, limited: 0, refused: 0, wrongKey: 0, total: 0, last: 0 };
      }
      if (entry.kind === 'admin') row.wrongKey++;
      else row[entry.kind]++;
      if (entry.kind === 'upload') row.bytes += uploadBytes(entry);
      if (!row.name && entry.name) row.name = entry.name;
      row.last = Math.max(row.last, entry.at);
      row.total++;
    });
    return Object.keys(rows).map(function (key) { return rows[key]; }).sort(byOrder);
  }
  function num(value) { return h('td', { className: 'num' }, value ? count(value) : h('span', { className: 'muted' }, '0')); }
  function bytesCell(row) {
    return h('td', { className: 'num' }, row.upload ? size(row.bytes) : h('span', { className: 'muted' }, '0'));
  }
  function recordButton(value) {
    return h('button', { type: 'button', onclick: function () { showActivityFor(value); } }, '記録');
  }
  function roomsButton(value) {
    return h('button', { type: 'button', onclick: function () { showRoomsBy(value); } }, '作った部屋');
  }
  /** Shows the first rows, and a button for the rest. */
  function fill(name, rows, render) {
    var body = $(name + '-body');
    var more = $(name + '-more');
    var shown = showAll[name] ? rows : rows.slice(0, TOP_ROWS);
    var columns = body.closest('table').querySelectorAll('thead th').length;
    if (rows.length === 0) body.replaceChildren(h('tr', null, h('td', { colspan: columns, className: 'empty' }, 'この期間には、いません。')));
    else body.replaceChildren.apply(body, shown.map(render));
    more.hidden = rows.length <= TOP_ROWS;
    more.textContent = showAll[name] ? '上位' + TOP_ROWS + '件だけにする' : 'すべて表示する（' + count(rows.length) + '件）';
  }

  function renderTops(tallied, period) {
    var reason = '目立つ送信元（' + RANGE_LABELS[period.range] + '）';
    fill('senders', rowsBy(tallied.entries, function (entry) { return entry.address; }), function (row) {
      return h('tr', null,
        h('td', null, mono(row.key)),
        num(row.room), num(row.upload), bytesCell(row), num(row.login), num(row.limited), num(row.refused),
        h('td', { className: 'num' + (row.wrongKey ? ' error' : '') }, row.wrongKey ? count(row.wrongKey) : h('span', { className: 'muted' }, '0')),
        h('td', null, time(row.last)),
        h('td', { className: 'actions' }, banButtons(null, row.key, reason), recordButton(row.key), row.room ? roomsButton(row.key) : null));
    });
    fill('accounts', rowsBy(tallied.entries, function (entry) { return entry.discordId; }), function (row) {
      return h('tr', null,
        h('td', null, row.name || h('span', { className: 'muted' }, '—')),
        h('td', null, mono(row.key)),
        num(row.room), num(row.upload), bytesCell(row), num(row.login), num(row.refused),
        h('td', { className: 'num' + (row.wrongKey ? ' error' : '') }, row.wrongKey ? count(row.wrongKey) : h('span', { className: 'muted' }, '0')),
        h('td', null, time(row.last)),
        h('td', { className: 'actions' }, banButtons(row.key, null, '目立つアカウント（' + RANGE_LABELS[period.range] + '）'), recordButton(row.key), row.room ? roomsButton(row.key) : null,
          h('button', { type: 'button', onclick: function () { showAccount(row.key); } }, 'アカウント')));
    });
  }

  function renderBusyRooms() {
    var rooms = data.rooms.filter(function (room) { return room.members > 0; })
      .sort(function (a, b) { return b.members - a.members || b.createdAt - a.createdAt; });
    var body = $('busy-body');
    if (rooms.length === 0) { body.replaceChildren(h('tr', null, h('td', { colspan: 5, className: 'empty' }, 'いま人がいる部屋はありません。'))); return; }
    body.replaceChildren.apply(body, rooms.slice(0, TOP_ROWS).map(function (room) {
      return h('tr', null,
        h('td', null, room.name),
        h('td', { className: 'num' }, count(room.members)),
        h('td', { className: 'nowrap' }, room.hasPassword ? 'あり' : ''),
        h('td', null, time(room.createdAt)),
        h('td', { className: 'actions' }, h('button', { type: 'button', onclick: function () { showRoom(room); } }, '中を見る')));
    }));
    $('busy-more').hidden = rooms.length <= TOP_ROWS;
  }

  function renderOverview() {
    var period = periodOf(prefs.range, Date.now());
    var tallied = tally(period);
    ['day', 'week'].forEach(function (range) { $('range-' + range).setAttribute('aria-pressed', String(range === prefs.range)); });
    $('period').textContent = time(period.start) + ' から';
    renderAlerts(tallied, period);
    renderTiles(tallied);
    chart('chart-usage', period, [seriesOf(tallied, 'login'), seriesOf(tallied, 'room'), seriesOf(tallied, 'upload')], count);
    chart('chart-bytes', period, [{ series: SERIES.upload, label: '置いた大きさ', values: tallied.bytes }], size, 'bytes');
    chart('chart-blocked', period, [seriesOf(tallied, 'limited'), seriesOf(tallied, 'refused')], count);
    $('order').value = prefs.order;
    renderTops(tallied, period);
    renderBusyRooms();
  }

  // ---- Rooms ----

  function deleteRoom(room) {
    if (!confirm('部屋「' + room.name + '」を削除しますか。入っている人の接続は切れ、卓と画像と音声はすべて消えます。')) return;
    api('DELETE', 'rooms/' + room.roomKey)
      .then(function () { setStatus('部屋「' + room.name + '」を削除しました。', 'ok'); return load(); })
      .catch(function (err) { setStatus(messageOf(err), 'error'); });
  }

  function seatsTable(seats, room) {
    if (seats.length === 0) return h('p', { className: 'empty' }, 'いま入っている人はいません。');
    return h('div', { className: 'scroll' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, '役割'), h('th', null, 'ピアID'), h('th', null, 'ユーザーID'),
        h('th', null, 'Discord ID'), h('th', null, 'IPアドレス'), h('th', null, '入った時刻'), h('th', null, ''))),
      h('tbody', null, seats.map(function (seat) {
        return h('tr', null,
          h('td', null, h('span', { className: 'chip' }, ROLE_LABELS[seat.role] || seat.role)),
          h('td', null, mono(seat.peerId)),
          h('td', null, mono(seat.userId)),
          h('td', null, mono(seat.discordId)),
          h('td', null, mono(seat.address)),
          h('td', null, time(seat.joinedAt)),
          h('td', { className: 'actions' }, banButtons(seat.discordId, seat.address, '部屋「' + room.name + '」')));
      }))));
  }

  /** What kind of thing it is, by the first half of its type. */
  function sortOf(type) {
    var head = String(type || '').split('/')[0];
    return head === 'image' ? '画像' : head === 'audio' ? '音声' : 'そのほか';
  }

  function assetsBlock(assets, list) {
    if (assets.length === 0) return h('p', { className: 'empty' }, '画像と音声はありません。');
    var sorts = {};
    assets.forEach(function (asset) {
      var kind = sortOf(asset.type);
      var each = sorts[kind] || (sorts[kind] = { count: 0, bytes: 0 });
      each.count++;
      each.bytes += asset.size;
    });
    var ordered = assets.slice().sort(function (a, b) { return b.size - a.size; });
    var shown = showAll.assets ? ordered : ordered.slice(0, 50);
    return [
      h('div', { className: 'summary' },
        h('strong', null, '合計 ' + count(assets.length) + '件・' + size(sum(assets.map(function (asset) { return asset.size; })))),
        Object.keys(sorts).map(function (kind) {
          return h('span', { className: 'muted' }, kind + ' ' + count(sorts[kind].count) + '件・' + size(sorts[kind].bytes));
        })),
      h('div', { className: 'scroll' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'ファイル名'), h('th', null, '形式'), h('th', { className: 'num' }, '大きさ'), h('th', null, 'SHA-256'))),
        h('tbody', null, shown.map(function (asset) {
          return h('tr', null,
            h('td', null, asset.name || h('span', { className: 'muted' }, '（名前なし）')),
            h('td', null, mono(asset.type)),
            h('td', { className: 'num' }, size(asset.size)),
            h('td', null, keyText(asset.id)));
        })))),
      ordered.length > 50 ? h('button', { type: 'button', className: 'link more', onclick: function () {
        showAll.assets = !showAll.assets;
        list.replaceChildren();
        append(list, assetsBlock(assets, list));
      } }, showAll.assets ? '大きいものから50件だけにする' : 'すべて表示する（' + count(ordered.length) + '件）') : null
    ];
  }

  /** Who is in the room now, and the images and sounds it keeps (what takes up the store). */
  function showRoom(room) {
    var seats = $('room-seats');
    var assets = $('room-assets');
    showAll.assets = false;
    $('room-title').textContent = '部屋「' + room.name + '」';
    var creator = room.creator || {};
    $('room-meta').replaceChildren(h('div', { className: 'scroll' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'ID'), h('th', null, '鍵'), h('th', { className: 'num' }, '人数'), h('th', null, 'パスワード'),
        h('th', null, '作った時刻'), h('th', null, '作った人のDiscord ID'), h('th', null, '作った人のIPアドレス'))),
      h('tbody', null, h('tr', null, h('td', null, mono(room.roomId)), h('td', null, h('span', { className: 'mono long' }, room.roomKey)),
        h('td', { className: 'num' }, count(room.members)), h('td', null, room.hasPassword ? 'あり' : 'なし'), h('td', null, time(room.createdAt)),
        h('td', null, mono(creator.discordId)), h('td', null, mono(creator.address)))))));
    seats.replaceChildren(h('p', { className: 'muted' }, '読み込んでいます…'));
    assets.replaceChildren(h('p', { className: 'muted' }, '読み込んでいます…'));
    $('room-delete').onclick = function () { $('room-dialog').close(); deleteRoom(room); };
    $('room-dialog').showModal();
    api('GET', 'rooms/' + room.roomKey + '/seats')
      .then(function (res) { seats.replaceChildren(seatsTable(res.seats, room)); })
      .catch(function (err) { seats.replaceChildren(h('p', { className: 'error' }, messageOf(err))); });
    api('GET', 'rooms/' + room.roomKey + '/assets')
      .then(function (res) { assets.replaceChildren(); append(assets, assetsBlock(res.assets, assets)); })
      .catch(function (err) { assets.replaceChildren(h('p', { className: 'error' }, messageOf(err))); });
  }

  /** Shows the rooms whose maker is the sender or account, on the rooms tab. */
  function showRoomsBy(value) {
    $('rooms-search').value = value;
    $('rooms-occupied').checked = false;
    show('rooms');
    renderRooms();
  }

  /** The rooms as the rooms tab is set to show them. */
  function shownRooms() {
    var words = $('rooms-search').value.trim().toLowerCase();
    var onlyOccupied = $('rooms-occupied').checked;
    var order = $('rooms-order').value;
    return data.rooms.filter(function (room) {
      if (onlyOccupied && room.members === 0) return false;
      if (!words) return true;
      var creator = room.creator || {};
      return [room.name, room.roomId, room.roomKey, creator.discordId, creator.address]
        .some(function (field) { return field && String(field).toLowerCase().indexOf(words) >= 0; });
    }).sort(function (a, b) {
      if (order === 'members') return b.members - a.members || b.createdAt - a.createdAt;
      if (order === 'oldest') return a.createdAt - b.createdAt;
      return b.createdAt - a.createdAt;
    });
  }

  function pickedRooms() {
    return data.rooms.filter(function (room) { return picked[room.roomKey] === true; });
  }

  function renderPicked(rows) {
    var count = pickedRooms().length;
    $('rooms-delete').disabled = count === 0;
    $('rooms-delete').textContent = '選んだ部屋を削除' + (count ? '（' + count + '件）' : '');
    var all = $('rooms-all');
    var ticked = rows.filter(function (room) { return picked[room.roomKey]; }).length;
    all.checked = rows.length > 0 && ticked === rows.length;
    all.indeterminate = ticked > 0 && ticked < rows.length;
  }

  function renderRooms() {
    // Rooms that are gone are no longer picked.
    var here = {};
    data.rooms.forEach(function (room) { here[room.roomKey] = true; });
    Object.keys(picked).forEach(function (key) { if (!here[key]) delete picked[key]; });
    var rows = shownRooms();
    var occupied = data.rooms.filter(function (room) { return room.members > 0; }).length;
    $('rooms-summary').textContent = rows.length + '件を表示（部屋 ' + data.rooms.length + '件、人がいる部屋 ' + occupied + '件）';
    renderPicked(rows);
    var tbody = $('rooms-body');
    if (rows.length === 0) { tbody.replaceChildren(h('tr', null, h('td', { colspan: 10, className: 'empty' }, '部屋はありません。'))); return; }
    tbody.replaceChildren.apply(tbody, rows.map(function (room) {
      var creator = room.creator || {};
      var discordId = creator.discordId || null;
      var box = h('input', { type: 'checkbox', 'aria-label': '部屋「' + room.name + '」を選ぶ' });
      box.checked = picked[room.roomKey] === true;
      box.addEventListener('change', function () {
        if (box.checked) picked[room.roomKey] = true; else delete picked[room.roomKey];
        renderPicked(rows);
      });
      return h('tr', null,
        h('td', { className: 'pick' }, box),
        h('td', { className: 'wrap' }, room.name),
        h('td', null, mono(room.roomId)),
        h('td', null, keyText(room.roomKey)),
        h('td', { className: 'num' }, room.members),
        h('td', { className: 'nowrap' }, room.hasPassword ? 'あり' : ''),
        h('td', null, time(room.createdAt)),
        h('td', null, mono(discordId)),
        h('td', null, mono(creator.address)),
        h('td', { className: 'actions' },
          h('button', { type: 'button', onclick: function () { showRoom(room); } }, '中を見る'),
          h('button', { type: 'button', className: 'danger', onclick: function () { deleteRoom(room); } }, '削除'),
          banButtons(discordId, creator.address, '部屋「' + room.name + '」を作った')));
    }));
  }

  function pickAll() {
    var rows = shownRooms();
    var on = $('rooms-all').checked;
    rows.forEach(function (room) { if (on) picked[room.roomKey] = true; else delete picked[room.roomKey]; });
    renderRooms();
  }

  function deletePicked() {
    var rooms = pickedRooms();
    if (rooms.length === 0) return;
    if (!confirm('選んだ部屋' + rooms.length + '件を削除しますか。入っている人の接続は切れ、卓と画像と音声はすべて消えます。')) return;
    $('rooms-delete').disabled = true;
    removeRooms(rooms, '');
  }

  // ---- What happened ----

  /** What an operator did, or why someone was turned away from the dashboard, in words. */
  var ADMIN_ACTIONS = {
    login: 'ログインした',
    'register passkey': 'パスキーを登録した',
    'delete passkey': 'パスキーを消した',
    'end every session': 'すべての人をログアウトさせた',
    'delete room': '部屋を削除した',
    'view asset': '画像か音声を見た',
    'delete asset': '画像か音声を消した',
    'block asset': '二度と置かせないようにした',
    'unblock asset': 'また置けるようにした',
    'delete account': 'アカウントを削除した',
    pause: '緊急停止した',
    resume: '緊急停止をやめ、すべて再開した',
    loosen: '締めるのをやめ、元に戻した',
    ban: 'BANした',
    unban: 'BANを解いた'
  };
  var DENIED_ACTIONS = {
    'not-allowed': '断った（入れる人にない）',
    'mfa-required': '断った（Discordの2段階認証が無効）',
    passkey: '断った（パスキーで確かめられない）'
  };
  var BAN_KINDS = { ip: 'IPアドレス', discord: 'Discord ID' };

  /**
   * What an entry of the record says, taken apart into one fact for each column: what happened,
   * the room, and for each kind what it is about.
   */
  function factsOf(entry) {
    var detail = String(entry.detail || '');
    var words = detail.split(' ');
    var facts = {
      action: KIND_LABELS[entry.kind] || entry.kind,
      roomName: entry.roomKey ? roomName(entry.roomKey) : null,
      targetKind: '', target: '', format: '', bytes: null, sha: '', limit: '', banKind: '', banValue: ''
    };
    if (entry.kind === 'room' && !facts.roomName) facts.roomName = detail || null;
    if (entry.kind === 'upload') {
      facts.format = words[0] || '';
      facts.bytes = Number(words[1]) || 0;
      facts.sha = words[2] || '';
    }
    if (entry.kind === 'limited') facts.limit = LIMIT_LABELS[detail] || detail;
    if (entry.kind === 'refused') {
      facts.banKind = BAN_KINDS[words[0]] || words[0];
      facts.banValue = words.slice(1).join(' ');
    }
    if (entry.kind === 'admin') adminFacts(words, facts);
    return facts;
  }
  function adminFacts(words, facts) {
    var two = words.slice(0, 2).join(' ');
    var rest = words.slice(2).join(' ');
    if (words[0] === 'denied') {
      facts.action = DENIED_ACTIONS[words[1]] || '断った（' + words.slice(1).join(' ') + '）';
    } else if (ADMIN_ACTIONS[two]) {
      facts.action = ADMIN_ACTIONS[two];
      if (/ asset$/.test(two)) { facts.targetKind = 'SHA-256'; facts.target = rest; }
      if (/ passkey$/.test(two)) { facts.targetKind = 'パスキー'; facts.target = rest; }
      if (two === 'delete account') { facts.targetKind = 'Discord ID'; facts.target = rest; }
    } else if (words[0] === 'ban' || words[0] === 'unban') {
      facts.action = ADMIN_ACTIONS[words[0]];
      facts.targetKind = BAN_KINDS[words[1]] || words[1];
      facts.target = rest;
    } else if (words[0] === 'tighten') {
      facts.action = '回数の上限を締めた';
      facts.targetKind = '締めたもの';
      facts.target = String(words[1] || '').split(',').map(function (pair) {
        var parts = pair.split('=');
        return (LIMIT_LABELS[parts[0]] || parts[0]) + ' 1/' + parts[1];
      }).join('・');
    } else if (words[0] === 'pause') {
      facts.action = ADMIN_ACTIONS.pause;
      facts.targetKind = '止めたもの';
      facts.target = String(words[1] || '').split(',').map(function (kind) { return PAUSE_LABELS[kind] || kind; }).join('・');
    } else {
      facts.action = ADMIN_ACTIONS[words.join(' ')] || words.join(' ');
    }
  }

  function dash() { return h('span', { className: 'muted' }, '—'); }
  /**
   * The record's columns. Each holds one kind of fact; which are shown depends on the kind of entry
   * the record is narrowed to.
   */
  var ACTIVITY_COLUMNS = {
    time: { head: '時刻', cell: function (entry) { return time(entry.at); } },
    kind: { head: '出来事', cell: function (entry, facts) { return kindChip(entry.kind, facts.action); } },
    action: { head: '操作', wrap: true, cell: function (entry, facts) { return facts.action; } },
    name: { head: '名前', wrap: true, cell: function (entry, facts, names) { return entry.name || names[entry.discordId] || dash(); } },
    discord: { head: 'Discord ID', cell: function (entry) { return mono(entry.discordId); } },
    address: { head: 'IPアドレス', cell: function (entry) { return mono(entry.address); } },
    room: { head: '部屋', wrap: true, cell: function (entry, facts) {
      return facts.roomName || (entry.roomKey ? h('span', { className: 'muted' }, '（一覧にない部屋）') : dash());
    } },
    roomKey: { head: '部屋の鍵', cell: function (entry) { return keyText(entry.roomKey); } },
    format: { head: '形式', cell: function (entry, facts) { return mono(facts.format); } },
    bytes: { head: '大きさ', num: true, cell: function (entry, facts) { return facts.bytes === null ? dash() : size(facts.bytes); } },
    sha: { head: 'SHA-256', cell: function (entry, facts) { return keyText(facts.sha); } },
    limit: { head: '上限', cell: function (entry, facts) { return facts.limit; } },
    banKind: { head: 'BANの種類', cell: function (entry, facts) { return facts.banKind; } },
    banValue: { head: 'BANの対象', cell: function (entry, facts) { return mono(facts.banValue); } },
    targetKind: { head: '対象の種類', wrap: true, cell: function (entry, facts) { return facts.targetKind || dash(); } },
    target: { head: '対象', wrap: true, cell: function (entry, facts) {
      if (!facts.target) return dash();
      return facts.targetKind === 'SHA-256' ? keyText(facts.target) : h('span', { className: facts.targetKind === 'パスキー' || facts.targetKind === '止めたもの' ? '' : 'mono' }, facts.target);
    } }
  };
  var ACTIVITY_VIEWS = {
    '': ['time', 'kind', 'name', 'discord', 'address', 'room'],
    login: ['time', 'name', 'discord', 'address'],
    room: ['time', 'name', 'discord', 'address', 'room', 'roomKey'],
    upload: ['time', 'name', 'discord', 'address', 'room', 'roomKey', 'format', 'bytes', 'sha'],
    limited: ['time', 'address', 'limit'],
    refused: ['time', 'name', 'discord', 'address', 'banKind', 'banValue'],
    admin: ['time', 'action', 'name', 'discord', 'address', 'room', 'roomKey', 'targetKind', 'target']
  };

  function kindChip(kind, label) {
    return h('span', { className: 'chip ' + kind }, SERIES[kind] ? h('i', { className: 'swatch s' + SERIES[kind] }) : null, label || KIND_LABELS[kind] || kind);
  }

  function showActivityFor(value) {
    $('activity-kind').value = '';
    $('activity-search').value = value;
    show('activity');
    renderActivity();
  }

  /** What happened, as the activity tab is set to show it. */
  function shownActivity() {
    var kind = $('activity-kind').value;
    var words = $('activity-search').value.trim().toLowerCase();
    return data.activity.filter(function (entry) {
      if (kind && entry.kind !== kind) return false;
      if (!words) return true;
      return [entry.address, entry.discordId, entry.name, entry.roomKey, entry.detail, roomName(entry.roomKey)]
        .some(function (field) { return field && String(field).toLowerCase().indexOf(words) >= 0; });
    });
  }

  function renderActivity() {
    var rows = shownActivity();
    var columns = ACTIVITY_VIEWS[$('activity-kind').value] || ACTIVITY_VIEWS[''];
    var names = namesById();
    $('activity-summary').textContent = rows.length + '件（運営する人の操作は90日・1000件まで、ほかは7日・2000件まで残しています）';
    var head = $('activity-head');
    head.replaceChildren.apply(head, columns.map(function (column) {
      return h('th', { className: ACTIVITY_COLUMNS[column].num ? 'num' : '' }, ACTIVITY_COLUMNS[column].head);
    }).concat([h('th', null, '')]));
    var tbody = $('activity-body');
    if (rows.length === 0) { tbody.replaceChildren(h('tr', null, h('td', { colspan: columns.length + 1, className: 'empty' }, '記録はありません。'))); return; }
    tbody.replaceChildren.apply(tbody, rows.map(function (entry) {
      var facts = factsOf(entry);
      return h('tr', null,
        columns.map(function (column) {
          var spec = ACTIVITY_COLUMNS[column];
          return h('td', { className: spec.num ? 'num' : spec.wrap ? 'wrap' : '' }, spec.cell(entry, facts, names));
        }),
        h('td', { className: 'actions' }, entry.kind === 'admin' && !isDenied(entry) ? null : banButtons(entry.discordId, entry.address, (KIND_LABELS[entry.kind] || entry.kind) + ' ' + time(entry.at))));
    }));
  }

  // ---- Bans ----

  /** How long a ban has left, in the largest units that say it. */
  function remaining(expiresAt) {
    if (expiresAt === null) return '解除するまで';
    var minutes = Math.max(0, Math.ceil((expiresAt - Date.now()) / 60000));
    var days = Math.floor(minutes / 1440);
    var hours = Math.floor((minutes % 1440) / 60);
    if (days > 0) return 'あと' + days + '日' + (hours ? hours + '時間' : '');
    if (hours > 0) return 'あと' + hours + '時間' + (minutes % 60 ? (minutes % 60) + '分' : '');
    return 'あと' + minutes + '分';
  }

  function renderBans() {
    var tbody = $('bans-body');
    $('bans-summary').textContent = 'BAN ' + data.bans.length + '件';
    if (data.bans.length === 0) { tbody.replaceChildren(h('tr', null, h('td', { colspan: 7, className: 'empty' }, 'BANはありません。'))); return; }
    tbody.replaceChildren.apply(tbody, data.bans.map(function (ban) {
      var made = roomsMadeBy(ban.kind, ban.value).length;
      return h('tr', null,
        h('td', null, h('span', { className: 'chip' }, ban.kind === 'ip' ? 'IPアドレス' : 'Discord ID')),
        h('td', null, mono(ban.value)),
        h('td', null, ban.reason),
        h('td', null, time(ban.createdAt)),
        h('td', null, ban.expiresAt === null ? '無期限' : time(ban.expiresAt)),
        h('td', null, remaining(ban.expiresAt)),
        h('td', { className: 'actions' },
          h('button', { type: 'button', onclick: function () { showActivityFor(ban.kind === 'ip' ? ban.value.split('/')[0] : ban.value); } }, '記録'),
          made ? h('button', { type: 'button', onclick: function () { showRoomsBy(ban.kind === 'ip' ? ban.value.split('/')[0] : ban.value); } }, '作った部屋 ' + made + '件') : null,
          h('button', { type: 'button', onclick: function () { prepareBan(ban.kind, ban.value, ban.reason, true); } }, '変更'),
          h('button', { type: 'button', onclick: function () { liftBan(ban); } }, '解除')));
    }));
  }

  // ---- Saving as CSV ----

  var NEWLINE = String.fromCharCode(13, 10);

  /**
   * A cell of CSV. One that a spreadsheet would take for a formula (room names and Discord names come
   * from anyone) is led by an apostrophe, so that it stays text.
   */
  function cell(value) {
    var text = value === null || value === undefined ? '' : String(value);
    if (/^[=+@-]/.test(text) || text.charAt(0) === String.fromCharCode(9) || text.charAt(0) === String.fromCharCode(13)) {
      text = "'" + text;
    }
    return '"' + text.replace(/"/g, '""') + '"';
  }

  /** Has the browser save the rows as a CSV file (UTF-8 with a BOM, so that spreadsheets read it right). */
  function saveCsv(name, header, rows) {
    var lines = [header].concat(rows).map(function (row) { return row.map(cell).join(','); });
    var blob = new Blob([String.fromCharCode(0xfeff) + lines.join(NEWLINE) + NEWLINE], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var stamp = new Date();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var link = h('a', {
      href: url,
      download: name + '-' + stamp.getFullYear() + pad(stamp.getMonth() + 1) + pad(stamp.getDate()) + '-' + pad(stamp.getHours()) + pad(stamp.getMinutes()) + '.csv'
    });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function iso(ms) { return ms === null || ms === undefined ? '' : new Date(ms).toISOString(); }

  function saveRooms() {
    saveCsv('rooms', ['名前', 'ID', '鍵', '人数', 'パスワード', '作った時刻', '作った人のDiscord ID', '作った人のIPアドレス'],
      shownRooms().map(function (room) {
        var creator = room.creator || {};
        return [room.name, room.roomId, room.roomKey, room.members, room.hasPassword ? 'あり' : '', iso(room.createdAt), creator.discordId, creator.address];
      }));
  }
  function saveActivity() {
    var names = namesById();
    saveCsv('activity', ['時刻', '種類', '出来事', '名前', 'Discord ID', 'IPアドレス', '部屋の名前', '部屋の鍵', '形式', '大きさ（バイト）', 'SHA-256',
      '上限', 'BANの種類', 'BANの対象', '対象の種類', '対象'],
      shownActivity().map(function (entry) {
        var facts = factsOf(entry);
        return [iso(entry.at), KIND_LABELS[entry.kind] || entry.kind, facts.action, entry.name || names[entry.discordId], entry.discordId, entry.address,
          facts.roomName, entry.roomKey, facts.format, facts.bytes, facts.sha, facts.limit, facts.banKind, facts.banValue, facts.targetKind, facts.target];
      }));
  }
  function saveBans() {
    saveCsv('bans', ['種類', '対象', '理由', 'BANした時刻', '終わる時刻'], data.bans.map(function (ban) {
      return [ban.kind === 'ip' ? 'IPアドレス' : 'Discord ID', ban.value, ban.reason, iso(ban.createdAt), ban.expiresAt === null ? '無期限' : iso(ban.expiresAt)];
    }));
  }

  // ---- The page ----

  /** The counts beside the menu, and a mark on the overview when there is something to warn of. */
  function renderMenu() {
    var period = periodOf(prefs.range, Date.now());
    var warnings = alertsOf(tally(period), period).length;
    $('menu-rooms').textContent = count(data.rooms.length);
    $('menu-bans').textContent = count(banIndex.ranges.length + Object.keys(banIndex.accounts).length);
    $('menu-flag').hidden = warnings === 0;
    $('menu-flag').title = warnings + '件の注意があります';
  }

  function render() {
    indexBans();
    renderMenu();
    if (prefs.tab === 'overview') renderOverview();
    renderRooms();
    renderActivity();
    renderBans();
  }

  function setMenu(open) {
    $('app').classList.toggle('menu-open', open);
    $('menu-open').setAttribute('aria-expanded', String(open));
  }

  function show(name) {
    // What was said belongs to the screen it was said on.
    if (name !== prefs.tab) setStatus('');
    prefs.tab = name;
    savePrefs();
    TABS.forEach(function (each) {
      $('tab-' + each).hidden = each !== name;
      $('show-' + each).setAttribute('aria-selected', String(each === name));
    });
    $('page-title').textContent = TITLES[name];
    document.title = TITLES[name] + ' - 部屋のサーバーの管理';
    setMenu(false);
    // The charts take the width they are shown at.
    if (name === 'overview') renderOverview();
    if (name === 'security' && !$('app').hidden) renderSecurity();
    if (name === 'uploads' && !$('app').hidden) {
      if (uploads) renderUploads();
      else loadUploads();
    }
    if (name === 'settings' && !$('app').hidden) renderSettings();
  }

  function load() {
    if (loading) return Promise.resolve();
    loading = true;
    $('refresh').disabled = true;
    $('app').classList.add('loading');
    return Promise.all([api('GET', 'rooms'), api('GET', 'activity'), api('GET', 'bans'), api('GET', 'pause'), api('GET', 'storage'),
      api('GET', 'tighten')])
      .then(function (results) {
        data = { rooms: results[0].rooms, activity: results[1].activity, bans: results[2].bans };
        pauseState = results[3].pause;
        storageState = results[4];
        tightenState = results[5].tighten;
        renderTighten();
        render();
        renderPause();
        renderUploads();
        $('loaded').textContent = time(Date.now()) + ' に読み込みました';
      })
      .catch(function (err) {
        if (!(err instanceof ApiError && err.status === 401)) setStatus(messageOf(err), 'error');
      })
      .then(function () {
        loading = false;
        $('refresh').disabled = false;
        $('app').classList.remove('loading');
      });
  }

  /** Reads everything again every REFRESH_MS while the tab is in view and nothing is open over it. */
  function setAuto(on) {
    prefs.auto = on;
    savePrefs();
    $('auto').checked = on;
    if (timer !== null) clearInterval(timer);
    timer = on ? setInterval(function () {
      if (!document.hidden && !$('app').hidden && !$('room-dialog').open && !$('asset-dialog').open) load();
    }, REFRESH_MS) : null;
  }

  // ---- Stopping everyone for a while ----

  function pausedKinds() {
    return PAUSE_KINDS.filter(function (kind) { return pauseState && pauseState[kind]; });
  }

  function renderPause() {
    var kinds = pausedKinds();
    var words = kinds.map(function (kind) { return PAUSE_LABELS[kind]; }).join('・');
    $('pause-banner').hidden = kinds.length === 0;
    renderSafetyFlag();
    $('pause-text').textContent = kinds.length ? words + 'を止めています（' + time(pauseState.since) + 'から）。' : '';
    PAUSE_KINDS.forEach(function (kind) { $('pause-' + kind).checked = !!(pauseState && pauseState[kind]); });
    $('pause-state').textContent = kinds.length ? 'いま止めているもの：' + words + '（' + time(pauseState.since) + 'から）' : 'いまは何も止めていません。';
  }

  function applyPause(resumeAll) {
    var body = {};
    PAUSE_KINDS.forEach(function (kind) { body[kind] = !resumeAll && $('pause-' + kind).checked; });
    var stopping = PAUSE_KINDS.filter(function (kind) { return body[kind]; });
    if (stopping.length && !confirm(stopping.map(function (kind) { return PAUSE_LABELS[kind]; }).join('・') +
      'を、すべての人について止めますか。部屋に入っている人とログインしている人は、そのまま使えます。')) return;
    api('PUT', 'pause', body).then(function (res) {
      pauseState = res.pause;
      renderPause();
      setStatus(stopping.length ? '止めました。原因が分かったら、ここで再開してください。' : 'すべて再開しました。', 'ok');
    }).catch(function (err) { setStatus(messageOf(err), 'error'); });
  }

  /** The mark on the security menu while anything is stopped or tightened. */
  function renderSafetyFlag() {
    var stopped = pausedKinds().length > 0;
    var tight = tightKinds().length > 0;
    $('menu-paused').hidden = !stopped && !tight;
    $('menu-paused').title = stopped ? '緊急停止中です' : '回数の上限を締めています';
  }

  // ---- Tightening the rate limits for a while ----

  function tightKinds() {
    return TIGHTEN_KINDS.filter(function (kind) { return tightenState && tightenState[kind] > 1; });
  }
  function fractionOf(weight) { return weight > 1 ? '1/' + weight : 'ふつう'; }

  function renderTighten() {
    var kinds = tightKinds();
    var words = kinds.map(function (kind) { return LIMIT_LABELS[kind] + ' ' + fractionOf(tightenState[kind]); }).join('・');
    $('tighten-banner').hidden = kinds.length === 0;
    $('tighten-text').textContent = kinds.length ? words + 'に締めています（' + time(tightenState.since) + 'から）。' : '';
    TIGHTEN_KINDS.forEach(function (kind) { $('tighten-' + kind).value = String(tightenState ? tightenState[kind] : 1); });
    $('tighten-state').textContent = kinds.length ? 'いま締めているもの：' + words + '（' + time(tightenState.since) + 'から）' : 'いまはどれも締めていません。';
    renderSafetyFlag();
  }

  function applyTighten(loosenAll) {
    var body = {};
    TIGHTEN_KINDS.forEach(function (kind) { body[kind] = loosenAll ? 1 : Number($('tighten-' + kind).value); });
    var tight = TIGHTEN_KINDS.filter(function (kind) { return body[kind] > 1; });
    if (tight.length && !confirm(tight.map(function (kind) { return LIMIT_LABELS[kind] + ' ' + fractionOf(body[kind]); }).join('・') +
      'に締めますか。1つの送信元が1分にできる回数が、その分だけ減ります。ほかのインスタンスには30秒ほどで行き渡ります。')) return;
    api('PUT', 'tighten', body).then(function (res) {
      tightenState = res.tighten;
      renderTighten();
      setStatus(tight.length ? '締めました。落ち着いたら、ここで元に戻してください。' : '回数の上限を元に戻しました。', 'ok');
    }).catch(function (err) { setStatus(messageOf(err), 'error'); });
  }

  // ---- What was uploaded ----

  /** Reads every asset in the store (it lists them a page at a time), and the ones barred. */
  function loadUploads() {
    if (uploadsLoading) return Promise.resolve();
    uploadsLoading = true;
    var all = [];
    $('uploads-summary').textContent = '読み込んでいます…';
    function page(cursor, pages) {
      return api('GET', 'assets' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : '')).then(function (res) {
        all = all.concat(res.assets);
        return res.cursor && pages < MAX_INVENTORY_PAGES ? page(res.cursor, pages + 1) : res.cursor;
      });
    }
    return Promise.all([page(null, 1), api('GET', 'blocked')]).then(function (results) {
      uploads = { assets: all, more: results[0] !== null, blocked: results[1].ids };
      renderUploads();
    }).catch(function (err) {
      $('uploads-summary').textContent = '';
      setStatus(messageOf(err), 'error');
    }).then(function () { uploadsLoading = false; });
  }

  /** Takes what is gone out of the list kept, so that nothing has to be read again. */
  function dropUploads(match) {
    uploads.assets = uploads.assets.filter(function (asset) { return !match(asset); });
    renderUploads();
  }

  /** Who stored each asset, from what was written down (seven days), by room and id. */
  function uploadersOf() {
    var by = {};
    data.activity.forEach(function (entry) {
      var id = entry.kind === 'upload' ? String(entry.detail || '').split(' ')[2] : null;
      if (id && entry.roomKey && !by[entry.roomKey + '|' + id]) by[entry.roomKey + '|' + id] = entry;
    });
    return by;
  }

  function assetLabel(asset) { return asset.name || asset.id; }

  function shownUploads() {
    var words = $('uploads-search').value.trim().toLowerCase();
    var kind = $('uploads-kind').value;
    var order = $('uploads-order').value;
    var who = uploadersOf();
    return uploads.assets.filter(function (asset) {
      if (kind && sortOf(asset.type) !== kind) return false;
      if (!words) return true;
      var by = who[asset.roomKey + '|' + asset.id] || {};
      return [asset.name, asset.id, asset.roomKey, roomName(asset.roomKey), by.discordId, by.address, by.name]
        .some(function (field) { return field && String(field).toLowerCase().indexOf(words) >= 0; });
    }).sort(function (a, b) { return order === 'size' ? b.size - a.size : b.uploadedAt - a.uploadedAt; });
  }

  function renderUploads() {
    if (!uploads) return;
    var who = uploadersOf();
    var rows = shownUploads();
    var rooms = {};
    uploads.assets.forEach(function (asset) { (rooms[asset.id] = rooms[asset.id] || []).push(asset.roomKey); });
    var total = sum(uploads.assets.map(function (asset) { return asset.size; }));
    $('uploads-summary').textContent = count(rows.length) + '件を表示（全部で ' + count(uploads.assets.length) + '件・' + size(total) +
      (uploads.more ? '。多すぎるので、先頭の' + count(uploads.assets.length) + '件だけを読みました' : '') + '）';
    renderRoomUsage();
    var names = namesById();
    var body = $('uploads-body');
    if (rows.length === 0) {
      body.replaceChildren(h('tr', null, h('td', { colspan: 10, className: 'empty' }, '置いてある画像と音声はありません。')));
    } else {
      body.replaceChildren.apply(body, rows.slice(0, uploadsShown).map(function (asset) {
        var by = who[asset.roomKey + '|' + asset.id] || {};
        var others = rooms[asset.id].length - 1;
        var none = function () { return h('span', { className: 'muted' }, '—'); };
        return h('tr', null,
          h('td', null, time(asset.uploadedAt)),
          h('td', { className: 'wrap' }, asset.name || h('span', { className: 'muted' }, '（名前なし）')),
          h('td', { className: 'nowrap' }, sortOf(asset.type)),
          h('td', { className: 'num' }, size(asset.size)),
          h('td', { className: 'wrap' }, roomName(asset.roomKey) || h('span', { className: 'muted' }, '（一覧にない部屋）')),
          h('td', { className: 'num' }, others > 0 ? count(others) : h('span', { className: 'muted' }, '0')),
          h('td', { className: 'wrap' }, (by.discordId && names[by.discordId]) || none()),
          h('td', null, by.discordId ? mono(by.discordId) : none()),
          h('td', null, by.address ? mono(by.address) : none()),
          h('td', { className: 'actions' }, h('button', { type: 'button', onclick: function () { showAsset(asset); } }, '詳しく')));
      }));
    }
    $('uploads-more').hidden = rows.length <= uploadsShown;
    $('uploads-more').textContent = 'もっと表示する（残り ' + count(rows.length - uploadsShown) + '件）';
    renderBlocked();
  }

  /** The rooms that take up the most of the store. */
  function renderRoomUsage() {
    var byRoom = {};
    uploads.assets.forEach(function (asset) {
      var room = byRoom[asset.roomKey] || (byRoom[asset.roomKey] = { roomKey: asset.roomKey, count: 0, bytes: 0 });
      room.count++;
      room.bytes += asset.size;
    });
    var top = Object.keys(byRoom).map(function (key) { return byRoom[key]; })
      .sort(function (a, b) { return b.bytes - a.bytes; }).slice(0, TOP_ROWS);
    var body = $('usage-body');
    var roomLimit = storageState.roomLimitBytes;
    $('usage-share').hidden = roomLimit === null;
    $('usage-share').textContent = roomLimit === null ? '' : '上限（' + count(roomLimit / 1e6) + ' MB）に対して';
    if (top.length === 0) { body.replaceChildren(h('tr', null, h('td', { colspan: roomLimit === null ? 5 : 6, className: 'empty' }, 'ありません。'))); return; }
    body.replaceChildren.apply(body, top.map(function (usage) {
      var room = data.rooms.filter(function (each) { return each.roomKey === usage.roomKey; })[0];
      return h('tr', null,
        h('td', { className: 'wrap' }, room ? room.name : h('span', { className: 'muted' }, '（一覧にない部屋）')),
        h('td', null, keyText(usage.roomKey)),
        h('td', { className: 'num' }, count(usage.count)),
        h('td', { className: 'num' }, size(usage.bytes)),
        roomLimit === null ? null : h('td', { className: 'num' + (usage.bytes >= roomLimit ? ' error' : '') }, Math.round((usage.bytes / roomLimit) * 100) + '%'),
        h('td', { className: 'actions' }, room ? h('button', { type: 'button', onclick: function () { showRoom(room); } }, '中を見る') : null));
    }));
  }

  function renderBlocked() {
    var body = $('blocked-body');
    if (uploads.blocked.length === 0) { body.replaceChildren(h('tr', null, h('td', { colspan: 2, className: 'empty' }, '置かせないものはありません。'))); return; }
    body.replaceChildren.apply(body, uploads.blocked.map(function (id) {
      return h('tr', null, h('td', null, h('span', { className: 'mono', title: id }, id)),
        h('td', { className: 'actions' }, h('button', { type: 'button', onclick: function () { unblockAsset(id); } }, '解除')));
    }));
  }

  /** The rooms the uploads tab found the asset in. */
  function roomsOf(asset) {
    var found = uploads ? uploads.assets.filter(function (each) { return each.id === asset.id; }).map(function (each) { return each.roomKey; }) : [];
    return found.length ? found : [asset.roomKey];
  }

  /** One row of a table of facts: what it is, and its value. */
  function fact(name, value) { return h('tr', null, h('th', { scope: 'row' }, name), h('td', null, value)); }

  /**
   * Everything known of an uploaded asset, and what can be done to it and to who stored it. Its
   * contents are read only when asked for, since each look is written down.
   */
  function showAsset(asset) {
    var by = uploadersOf()[asset.roomKey + '|' + asset.id] || {};
    var names = namesById();
    $('asset-title').textContent = asset.name || '（名前なし）';
    $('asset-facts').replaceChildren(h('table', { className: 'facts' }, h('tbody', null,
      fact('ファイル名', asset.name || dash()),
      fact('種類', sortOf(asset.type)),
      fact('形式', mono(asset.type)),
      fact('大きさ', size(asset.size)),
      fact('SHA-256', h('span', { className: 'mono long' }, asset.id)),
      fact('置いた時刻', time(asset.uploadedAt)),
      fact('部屋', roomName(asset.roomKey) || h('span', { className: 'muted' }, '（一覧にない部屋）')),
      fact('部屋の鍵', h('span', { className: 'mono long' }, asset.roomKey)),
      fact('ほかの部屋', count(roomsOf(asset).length - 1) + '件'),
      fact('置いた人', (by.discordId && names[by.discordId]) || dash()),
      fact('置いた人のDiscord ID', by.discordId ? mono(by.discordId) : dash()),
      fact('置いた人のIPアドレス', by.address ? mono(by.address) : dash()))));
    $('asset-body').replaceChildren(
      h('button', { type: 'button', onclick: function () { viewAsset(asset); } }, '中身を見る'),
      h('p', { className: 'hint' }, '中身を見ると、見たことが記録に残ります。見るのは、申し立てや不正な使われかたに応えるときだけにしてください。'));
    $('asset-actions').replaceChildren();
    append($('asset-actions'), [
      h('button', { type: 'button', className: 'danger', onclick: function () { removeAsset(asset); } }, 'この部屋から消す'),
      h('button', { type: 'button', className: 'danger', onclick: function () { takeDown(asset, roomsOf(asset)); } }, '消して二度と置かせない'),
      banButtons(by.discordId, by.address, 'アップロード「' + assetLabel(asset) + '」')
    ]);
    $('asset-dialog').showModal();
  }

  /** Reads the asset's contents and shows them in the dialog. The server writes the look down. */
  function viewAsset(asset) {
    var body = $('asset-body');
    body.replaceChildren(h('p', { className: 'muted' }, '読み込んでいます…'));
    fetch(base + 'api/rooms/' + asset.roomKey + '/assets/' + asset.id + '/content', {
      headers: { 'X-Admin-Request': '1' },
      credentials: 'same-origin',
      cache: 'no-store'
    }).then(function (res) {
      if (!res.ok) throw new ApiError(res.status, 'unknown');
      return res.blob();
    }).then(function (blob) {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(blob);
      body.replaceChildren(asset.type.indexOf('audio/') === 0
        ? h('audio', { controls: true, src: previewUrl })
        : h('img', { className: 'preview', src: previewUrl, alt: assetLabel(asset) }));
    }).catch(function (err) { body.replaceChildren(h('p', { className: 'error' }, messageOf(err))); });
  }

  function removeAsset(asset) {
    if (!confirm('この部屋から「' + assetLabel(asset) + '」を消しますか。部屋にいる人がこの画像を手元に持っていれば、また置かれることがあります。二度と置かせないときは「消して二度と置かせない」を使ってください。')) return;
    api('DELETE', 'rooms/' + asset.roomKey + '/assets/' + asset.id)
      .then(function () {
        setStatus('「' + assetLabel(asset) + '」をこの部屋から消しました。', 'ok');
        dropUploads(function (each) { return each.roomKey === asset.roomKey && each.id === asset.id; });
      })
      .catch(function (err) { setStatus(messageOf(err), 'error'); });
  }

  function takeDown(asset, rooms) {
    if (!confirm('「' + assetLabel(asset) + '」を、置いてある部屋（' + rooms.length + '件）からすべて消し、どの部屋でも二度と置かせないようにしますか。')) return;
    api('POST', 'assets/' + asset.id + '/block', { rooms: rooms }).then(function (res) {
      setStatus(res.deleted + '件の部屋から消し、二度と置かせないようにしました。' + (res.failed ? '消せなかった部屋が' + res.failed + '件あります。読み込み直して、もう一度試してください。' : ''), res.failed ? 'error' : 'ok');
      if (uploads.blocked.indexOf(asset.id) < 0) uploads.blocked.push(asset.id);
      if (!res.failed) dropUploads(function (each) { return each.id === asset.id; });
      else loadUploads();
    }).catch(function (err) { setStatus(messageOf(err), 'error'); });
  }

  function unblockAsset(id) {
    if (!confirm('SHA-256が ' + id + ' のものを、また置けるようにしますか。')) return;
    api('DELETE', 'blocked/' + id)
      .then(function () {
        setStatus('また置けるようにしました。', 'ok');
        uploads.blocked = uploads.blocked.filter(function (each) { return each !== id; });
        renderBlocked();
      })
      .catch(function (err) { setStatus(messageOf(err), 'error'); });
  }

  function saveUploads() {
    var who = uploadersOf();
    saveCsv('uploads', ['置いた時刻', '名前', '種類', '大きさ（バイト）', 'ID', '部屋の鍵', '部屋の名前', '置いた人のDiscord ID', '置いた人のIPアドレス'],
      shownUploads().map(function (asset) {
        var by = who[asset.roomKey + '|' + asset.id] || {};
        return [iso(asset.uploadedAt), asset.name, asset.type, asset.size, asset.id, asset.roomKey, roomName(asset.roomKey), by.discordId, by.address];
      }));
  }

  // ---- Accounts ----

  function showAccount(discordId) {
    $('account-id').value = discordId;
    show('accounts');
    lookUpAccount();
  }

  function lookUpAccount(event) {
    if (event) event.preventDefault();
    var id = $('account-id').value.trim();
    var box = $('account-result');
    if (!/^[0-9]{1,20}$/.test(id)) {
      box.replaceChildren(h('p', { className: 'error' }, 'DiscordのユーザーID（数字）を入れてください。'));
      return;
    }
    box.replaceChildren(h('p', { className: 'muted' }, '調べています…'));
    api('GET', 'accounts/' + id).then(function (res) {
      var account = res.account;
      box.replaceChildren(
        h('table', { className: 'settings' }, h('tbody', null,
          h('tr', null, h('th', null, '名前'), h('td', null, account.name)),
          h('tr', null, h('th', null, 'Discord ID'), h('td', null, mono(account.discordId))),
          h('tr', null, h('th', null, 'ユーザーID'), h('td', null, mono(account.userId))))),
        h('div', { className: 'toolbar account-actions' },
          h('button', { type: 'button', className: 'danger', onclick: function () { deleteAccount(account); } }, 'アカウントを削除'),
          banButtons(account.discordId, null, 'アカウント「' + account.name + '」'),
          recordButton(account.discordId)),
        h('p', { className: 'hint' }, '削除すると、その人の名前とログインがすべて消えます。いま部屋に入っている席は、アクセストークンが切れるまで（長くて16分ほど）残ります。すぐに外すときは、Discord BANも使ってください。'));
    }).catch(function (err) {
      box.replaceChildren(err instanceof ApiError && err.status === 404
        ? h('p', { className: 'muted' }, 'このDiscord IDのアカウントはありません（ログインしたことが無いか、もう消えています）。')
        : h('p', { className: 'error' }, messageOf(err)));
    });
  }

  function deleteAccount(account) {
    if (!confirm(account.name + '（Discord ID ' + account.discordId + '）のアカウントを削除しますか。戻せません。')) return;
    api('DELETE', 'accounts/' + account.discordId).then(function () {
      $('account-result').replaceChildren(h('p', { className: 'ok' }, account.name + 'のアカウントを削除しました。'));
      setStatus('アカウントを削除しました。', 'ok');
    }).catch(function (err) { setStatus(messageOf(err), 'error'); });
  }

  // ---- Settings ----

  function renderSettings() {
    var body = $('settings-body');
    api('GET', 'settings').then(function (settings) {
      var row = function (name, keys, value) {
        return h('tr', null, h('td', null, name), h('td', null, keys.map(function (key) { return h('div', { className: 'mono' }, key); })), h('td', null, value));
      };
      var list = function (values) {
        return values.length ? values.map(function (value) { return h('div', { className: 'mono' }, value); }) : h('span', { className: 'muted' }, 'なし');
      };
      body.replaceChildren();
      append(body, [
        settings.passkeyReset.length
          ? h('div', { className: 'alert critical' }, h('span', { className: 'alert-icon', 'aria-hidden': 'true' }, '!'), h('span', { className: 'alert-label' }, '要対応'),
            h('span', null, 'ADMIN_PASSKEY_RESETが入ったままです。パスキーを登録し直したら、外してください。'))
          : null,
        h('div', { className: 'scroll' }, h('table', { className: 'settings' },
          h('thead', null, h('tr', null, h('th', null, '項目'), h('th', null, '環境変数'), h('th', null, '値'))),
          h('tbody', null,
            row('受けるAxeのOrigin', ['ACCESS_CONTROL_ALLOW_ORIGIN'], list(settings.allowedOrigins)),
            row('部屋を消すまでの時間（最後の1人が抜けてから）', ['ROOM_RETENTION_HOURS'], settings.roomRetentionHours + '時間'),
            row('ログイン（Discord）', ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'SESSION_SECRET'], settings.login ? '設定してあります' : '設定していません'),
            row('管理画面に入れる人（Discord ID）', ['ADMIN_DISCORD_IDS'], list(settings.admins)),
            row('パスキーを登録し直せる人（Discord ID）', ['ADMIN_PASSKEY_RESET'], list(settings.passkeyReset)),
            row('Discordへの知らせ', ['ADMIN_WEBHOOK_URL'], settings.webhook ? '送ります' : '送りません'),
            row('置き場所の使用量を知らせる量', ['ADMIN_STORAGE_ALERT_GB'], settings.storageAlertBytes === null ? h('span', { className: 'muted' }, 'なし（数えません）') : gb(settings.storageAlertBytes)),
            row('1部屋に置ける画像と音声の合計', ['ROOM_STORAGE_LIMIT_MB'], settings.roomStorageLimitBytes === null ? h('span', { className: 'muted' }, 'なし') : count(settings.roomStorageLimitBytes / 1e6) + ' MB'),
            row('断った人への問い合わせ先', ['ADMIN_CONTACT_URL'], settings.contactUrl === null ? h('span', { className: 'muted' }, 'なし') : h('span', { className: 'mono' }, settings.contactUrl)))))
      ]);
    }).catch(function (err) { body.replaceChildren(h('p', { className: 'error' }, messageOf(err))); });
  }

  // ---- Getting in ----

  /** The screen to log in through Discord, with why the last try was turned away. */
  function signedOut(message) {
    me = null;
    uploads = null;
    $('app').hidden = true;
    $('signin').hidden = false;
    $('signin-discord').hidden = false;
    $('signin-passkey').hidden = true;
    $('signin-error').textContent = message || '';
  }

  /** The screen to confirm a passkey (or register the first) once Discord has let the operator in. */
  function passkeyStage(session) {
    me = session;
    $('app').hidden = true;
    $('signin').hidden = false;
    $('signin-discord').hidden = true;
    $('signin-passkey').hidden = false;
    $('signin-error').textContent = '';
    $('passkey-greeting').textContent = session.name + 'さん（Discord ID ' + session.discordId + '）、Discordでのログインを確かめました。';
    $('passkey-confirm').hidden = session.passkeys === 0;
    $('passkey-register-block').hidden = !session.mayRegister;
    $('passkey-hint').textContent = session.passkeys === 0
      ? 'はじめてなので、この端末にパスキーを作って登録します。これからは、このパスキーで管理画面に入ります。'
      : session.mayRegister
        ? 'ADMIN_PASSKEY_RESETにより、新しいパスキーを登録できます。登録したら、失くした端末のパスキーを「安全」で消し、ADMIN_PASSKEY_RESETを外してください。'
        : 'この端末か、登録した別の端末のパスキーで確かめてください。';
  }

  /** Into the dashboard, once a passkey has confirmed the session. */
  function enter(session) {
    me = session;
    $('signin').hidden = true;
    $('app').hidden = false;
    $('operator').textContent = session.name;
    setStatus('');
    show(prefs.tab);
    return load();
  }

  /** Asks the server where the session stands, and shows the screen that fits. */
  function begin() {
    return api('GET', 'session').then(function (session) {
      if (session.stage === 'passkey') return enter(session);
      passkeyStage(session);
    }).catch(function (err) {
      if (!(err instanceof ApiError && err.status === 401)) signedOut(messageOf(err));
    });
  }

  function afterPasskey(promise, button) {
    button.disabled = true;
    $('signin-error').textContent = '';
    return promise.then(begin).catch(function (err) {
      $('signin-error').textContent = messageOf(err);
    }).then(function () { button.disabled = false; });
  }

  function logOut() {
    return api('POST', 'logout').catch(function () { return null; }).then(function () { signedOut(); });
  }

  // ---- Security ----

  function renderSecurity() {
    var body = $('passkeys-body');
    $('session-state').textContent = me
      ? me.name + 'さん（Discord ID ' + me.discordId + '）としてログインしています。パスキーで最後に確かめたのは ' + time(me.verifiedAt) + ' です。'
      : '';
    api('GET', 'passkeys').then(function (res) {
      if (res.passkeys.length === 0) { body.replaceChildren(h('tr', null, h('td', { colspan: 5, className: 'empty' }, 'パスキーはありません。'))); return; }
      body.replaceChildren.apply(body, res.passkeys.map(function (passkey) {
        return h('tr', null,
          h('td', null, passkey.name),
          h('td', null, passkey.algorithm === -7 ? 'ES256' : 'RS256'),
          h('td', null, time(passkey.createdAt)),
          h('td', null, time(passkey.usedAt)),
          h('td', { className: 'actions' }, h('button', { type: 'button', className: 'danger', onclick: function () { deletePasskey(passkey); } }, '削除')));
      }));
    }).catch(function (err) { setStatus(messageOf(err), 'error'); });
  }

  function deletePasskey(passkey) {
    if (!confirm('パスキー「' + passkey.name + '」を消しますか。その端末では管理画面に入れなくなります。')) return;
    api('DELETE', 'passkeys/' + encodeURIComponent(passkey.id))
      .then(function () { setStatus('パスキー「' + passkey.name + '」を消しました。', 'ok'); renderSecurity(); })
      .catch(function (err) { setStatus(messageOf(err), 'error'); });
  }

  function addPasskey() {
    var button = $('passkey-add');
    button.disabled = true;
    registerPasskey($('passkey-add-name').value.trim())
      .then(function () { $('passkey-add-name').value = ''; setStatus('この端末のパスキーを登録しました。', 'ok'); renderSecurity(); })
      .catch(function (err) { setStatus(messageOf(err), 'error'); })
      .then(function () { button.disabled = false; });
  }

  function endEverySession() {
    if (!confirm('すべての運営する人を、管理画面からログアウトさせますか。あなたもログアウトします。だれかにログインを盗まれたかもしれないときに使います。')) return;
    api('POST', 'sessions/revoke')
      .then(function () { signedOut('すべての人をログアウトさせました。'); })
      .catch(function (err) { setStatus(messageOf(err), 'error'); });
  }

  Array.prototype.forEach.call(document.querySelectorAll('.host-name'), function (el) { el.textContent = location.host; });
  $('menu-open').addEventListener('click', function () { setMenu(!$('app').classList.contains('menu-open')); });
  $('scrim').addEventListener('click', function () { setMenu(false); });
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape') setMenu(false); });
  $('discord-login').href = base + 'login';
  $('passkey-confirm').addEventListener('click', function () { afterPasskey(confirmPasskey(), $('passkey-confirm')); });
  $('passkey-register').addEventListener('click', function () {
    afterPasskey(registerPasskey($('passkey-name').value.trim()), $('passkey-register'));
  });
  $('signin-cancel').addEventListener('click', logOut);
  $('signout').addEventListener('click', logOut);
  $('passkey-add').addEventListener('click', addPasskey);
  $('pause-apply').addEventListener('click', function () { applyPause(false); });
  $('tighten-apply').addEventListener('click', function () { applyTighten(false); });
  $('tighten-loosen').addEventListener('click', function () { applyTighten(true); });
  $('tighten-go').addEventListener('click', function () { show('security'); });
  $('pause-resume').addEventListener('click', function () { applyPause(true); });
  $('pause-go').addEventListener('click', function () { show('security'); });
  $('uploads-search').addEventListener('input', renderUploads);
  $('uploads-kind').addEventListener('change', renderUploads);
  $('uploads-order').addEventListener('change', renderUploads);
  $('uploads-more').addEventListener('click', function () { uploadsShown += 200; renderUploads(); });
  $('uploads-csv').addEventListener('click', saveUploads);
  $('asset-close').addEventListener('click', function () { $('asset-dialog').close(); });
  // What is pressed below the facts (deleting, or getting a ban ready) goes on outside the dialog.
  $('asset-actions').addEventListener('click', function (event) {
    if (event.target.closest('button')) $('asset-dialog').close();
  });
  $('asset-dialog').addEventListener('close', function () {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    $('asset-body').replaceChildren();
  });
  $('account-form').addEventListener('submit', lookUpAccount);
  $('sessions-end').addEventListener('click', endEverySession);
  $('refresh').addEventListener('click', function () {
    setStatus('');
    load().then(function () {
      if (prefs.tab === 'uploads') loadUploads();
      if (prefs.tab === 'settings') renderSettings();
    });
  });
  $('auto').addEventListener('change', function () { setAuto($('auto').checked); });
  $('ban-form').addEventListener('submit', submitBan);
  $('rooms-csv').addEventListener('click', saveRooms);
  $('activity-csv').addEventListener('click', saveActivity);
  $('bans-csv').addEventListener('click', saveBans);
  $('activity-kind').addEventListener('change', renderActivity);
  $('activity-search').addEventListener('input', renderActivity);
  $('rooms-search').addEventListener('input', renderRooms);
  $('rooms-occupied').addEventListener('change', renderRooms);
  $('rooms-order').addEventListener('change', renderRooms);
  $('order').addEventListener('change', function () { prefs.order = $('order').value; savePrefs(); renderOverview(); });
  ['senders', 'accounts'].forEach(function (name) {
    $(name + '-more').addEventListener('click', function () { showAll[name] = !showAll[name]; renderOverview(); });
  });
  $('busy-more').addEventListener('click', function () {
    $('rooms-occupied').checked = true;
    $('rooms-order').value = 'members';
    show('rooms');
    renderRooms();
  });
  ['day', 'week'].forEach(function (range) {
    $('range-' + range).addEventListener('click', function () { prefs.range = range; savePrefs(); renderOverview(); });
  });
  $('room-close').addEventListener('click', function () { $('room-dialog').close(); });
  $('rooms-all').addEventListener('change', pickAll);
  $('rooms-delete').addEventListener('click', deletePicked);
  TABS.forEach(function (name) {
    $('show-' + name).addEventListener('click', function () { show(name); });
  });
  var width = 0;
  new ResizeObserver(function (changes) {
    var now = Math.round(changes[0].contentRect.width);
    if (now === width) return;
    width = now;
    if (prefs.tab === 'overview' && !$('app').hidden) renderOverview();
  }).observe($('tab-overview'));
  setAuto(prefs.auto);
  // Back from Discord turned away: the reason is in the fragment, which no server log keeps.
  var denied = /^#denied=([a-z-]+)$/.exec(location.hash);
  if (denied) history.replaceState(null, '', location.pathname);
  signedOut(denied ? DENIED[denied[1]] || 'ログインできませんでした（' + denied[1] + '）。' : '');
  if (!denied) begin();
})();
`;

const BODY = `
<section class="panel signin" id="signin">
  <h1>部屋のサーバーの管理</h1>
  <span class="host-name"></span>
  <div id="signin-discord">
    <p>運営する人のDiscordのアカウントでログインし、そのあと端末のパスキー（指紋や顔、PIN、セキュリティキー）で確かめます。</p>
    <p><a class="button primary" id="discord-login" href="login">Discordでログイン</a></p>
  </div>
  <div id="signin-passkey" hidden>
    <p id="passkey-greeting"></p>
    <p class="hint" id="passkey-hint"></p>
    <p><button type="button" class="primary" id="passkey-confirm">パスキーで確かめる</button></p>
    <div id="passkey-register-block">
      <label for="passkey-name">この端末の名前（パスキーを見分けるための控え）</label>
      <input id="passkey-name" maxlength="60" placeholder="ノートPC、スマートフォンなど">
      <p><button type="button" class="primary" id="passkey-register">この端末のパスキーを登録する</button></p>
    </div>
    <p><button type="button" id="signin-cancel">ログアウト</button></p>
  </div>
  <p class="error" id="signin-error" role="alert"></p>
</section>
<div class="shell" id="app" hidden>
  <aside class="sidebar" id="sidebar" aria-label="メニュー">
    <div class="brand"><strong>部屋のサーバーの管理</strong><span class="host-name"></span></div>
    <nav class="menu" role="tablist" aria-orientation="vertical">
      <button type="button" role="tab" id="show-overview"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>概要<span class="flag" id="menu-flag" hidden>!</span></button>
      <button type="button" role="tab" id="show-rooms"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/></svg>部屋<span class="count" id="menu-rooms"></span></button>
      <button type="button" role="tab" id="show-uploads"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/></svg>アップロード</button>
      <button type="button" role="tab" id="show-activity"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h12M9 12h12M9 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/></svg>記録</button>
      <button type="button" role="tab" id="show-bans"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/></svg>BAN<span class="count" id="menu-bans"></span></button>
      <button type="button" role="tab" id="show-accounts"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg>アカウント</button>
      <button type="button" role="tab" id="show-security"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6z"/><path d="m9 12 2 2 4-4"/></svg>安全<span class="flag" id="menu-paused" hidden>!</span></button>
      <button type="button" role="tab" id="show-settings"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/></svg>設定</button>
    </nav>
    <div class="sidebar-foot">
      <span class="muted" id="operator"></span>
      <button type="button" id="signout">ログアウト</button>
    </div>
  </aside>
  <div class="scrim" id="scrim"></div>
  <div class="content">
    <header class="topbar">
      <button type="button" id="menu-open" aria-controls="sidebar" aria-expanded="false">メニュー</button>
      <h1 id="page-title">概要</h1>
      <span class="spacer"></span>
      <span class="muted" id="loaded"></span>
      <label><input type="checkbox" id="auto">30秒ごとに読み込む</label>
      <button type="button" id="refresh">読み込み直す</button>
    </header>
    <main>
      <div class="alert critical pause-banner" id="pause-banner" hidden>
        <span class="alert-icon" aria-hidden="true">!</span><span class="alert-label">緊急停止中</span>
        <span id="pause-text"></span>
        <button type="button" id="pause-go">止めているものを見る</button>
      </div>
      <div class="alert warning pause-banner" id="tighten-banner" hidden>
        <span class="alert-icon" aria-hidden="true">!</span><span class="alert-label">締めています</span>
        <span id="tighten-text"></span>
        <button type="button" id="tighten-go">締めているものを見る</button>
      </div>
      <p class="status" id="status" role="status"></p>
      <div id="tab-overview" role="tabpanel">
              <div class="toolbar">
                <div class="segmented" role="group" aria-label="期間">
                  <button type="button" id="range-day" aria-pressed="true">24時間</button>
                  <button type="button" id="range-week" aria-pressed="false">7日</button>
                </div>
                <span class="muted" id="period"></span>
              </div>
              <div class="alerts" id="alerts"></div>
              <div class="tiles" id="tiles"></div>
              <div class="charts">
                <figure class="chart" id="chart-usage">
                  <figcaption><span class="chart-title">使われかた</span><span class="legend"></span></figcaption>
                  <div class="plot"></div>
                  <details><summary>数を表で見る</summary><div class="table-view scroll"></div></details>
                </figure>
                <figure class="chart" id="chart-bytes">
                  <figcaption><span class="chart-title">置いた画像と音声の大きさ</span><span class="legend"></span></figcaption>
                  <div class="plot"></div>
                  <details><summary>数を表で見る</summary><div class="table-view scroll"></div></details>
                  <p class="note">新しく置いた画像と音声だけを数えます（置いてあるものと同じなら数えません）。</p>
                </figure>
                <figure class="chart" id="chart-blocked">
                  <figcaption><span class="chart-title">回数の制限とBAN</span><span class="legend"></span></figcaption>
                  <div class="plot"></div>
                  <details><summary>数を表で見る</summary><div class="table-view scroll"></div></details>
                  <p class="note">どちらも、送信元ごとに1分に1回だけ数えます。</p>
                </figure>
              </div>
              <div class="order">
                <label for="order">目立つ送信元とアカウントの並べかた</label>
                <select id="order">
                  <option value="bytes">置いた画像と音声の大きさ</option>
                  <option value="room">作った部屋の数</option>
                  <option value="blocked">制限・BAN・管理画面で断った</option>
                  <option value="total">出来事の数</option>
                </select>
              </div>
              <div class="tops">
                <section class="block">
                  <div class="block-head"><h2>目立つ送信元</h2><span class="muted">IPアドレスごと</span></div>
                  <div class="scroll"><table>
                    <thead><tr><th>IPアドレス</th><th class="num">部屋を<wbr>作った</th><th class="num">画像と音声を<wbr>置いた</th><th class="num">置いた<wbr>大きさ</th>
                      <th class="num">ログイン</th><th class="num">回数の<wbr>制限</th><th class="num">BANで<wbr>断った</th><th class="num">管理画面で<wbr>断った</th><th>最後</th><th></th></tr></thead>
                    <tbody id="senders-body"></tbody>
                  </table></div>
                  <button type="button" class="link more" id="senders-more" hidden></button>
                </section>
                <section class="block">
                  <div class="block-head"><h2>目立つアカウント</h2><span class="muted">Discordのアカウントごと</span></div>
                  <div class="scroll"><table>
                    <thead><tr><th>名前</th><th>Discord ID</th><th class="num">部屋を<wbr>作った</th><th class="num">画像と音声を<wbr>置いた</th><th class="num">置いた<wbr>大きさ</th>
                      <th class="num">ログイン</th><th class="num">BANで<wbr>断った</th><th class="num">管理画面で<wbr>断った</th><th>最後</th><th></th></tr></thead>
                    <tbody id="accounts-body"></tbody>
                  </table></div>
                  <button type="button" class="link more" id="accounts-more" hidden></button>
                </section>
              </div>
              <section class="block">
                <div class="block-head"><h2>人がいる部屋</h2><span class="muted">人数の多いものから</span></div>
                <div class="scroll"><table>
                  <thead><tr><th>名前</th><th class="num">人数</th><th>パスワード</th><th>作った<wbr>時刻</th><th></th></tr></thead>
                  <tbody id="busy-body"></tbody>
                </table></div>
                <button type="button" class="link more" id="busy-more" hidden>人がいる部屋をすべて見る</button>
              </section>
    
      </div>
      <div id="tab-rooms" role="tabpanel" hidden>
        <section class="card">
                <div class="toolbar">
                  <input type="search" id="rooms-search" placeholder="名前・ID・鍵・作った人で絞り込む" aria-label="絞り込み">
                  <label><input type="checkbox" id="rooms-occupied">人がいる部屋だけ</label>
                  <select id="rooms-order" aria-label="並べかた">
                    <option value="newest">新しいものから</option>
                    <option value="members">人数の多いものから</option>
                    <option value="oldest">古いものから</option>
                  </select>
                  <span class="muted" id="rooms-summary"></span>
                  <span class="spacer"></span>
                  <button type="button" class="danger" id="rooms-delete" disabled>選んだ部屋を削除</button>
                  <button type="button" id="rooms-csv">CSVで保存</button>
                </div>
                <div class="scroll"><table>
                  <thead><tr><th class="pick"><input type="checkbox" id="rooms-all" aria-label="表示している部屋をすべて選ぶ"></th>
                    <th>名前</th><th>ID</th><th>鍵</th><th class="num">人数</th><th>パスワード</th><th>作った<wbr>時刻</th>
                    <th>作った人の<wbr>Discord ID</th><th>作った人の<wbr>IPアドレス</th><th></th></tr></thead>
                  <tbody id="rooms-body"></tbody>
                </table></div>
    
        </section>
      </div>
      <div id="tab-uploads" role="tabpanel" hidden>
        <section class="card">
          <div class="toolbar">
            <input type="search" id="uploads-search" placeholder="名前・ID・部屋・置いた人で絞り込む" aria-label="絞り込み">
            <select id="uploads-kind" aria-label="種類">
              <option value="">すべての種類</option>
              <option value="画像">画像</option>
              <option value="音声">音声</option>
            </select>
            <select id="uploads-order" aria-label="並べかた">
              <option value="newest">新しいものから</option>
              <option value="size">大きいものから</option>
            </select>
            <span class="muted" id="uploads-summary"></span>
            <span class="spacer"></span>
            <button type="button" id="uploads-csv">CSVで保存</button>
          </div>
          <div class="scroll"><table class="uploads">
            <thead><tr><th>置いた<wbr>時刻</th><th>ファイル名</th><th>種類</th><th class="num">大きさ</th><th>部屋</th><th class="num">ほかの<wbr>部屋</th>
              <th>置いた人</th><th>置いた人の<wbr>Discord ID</th><th>置いた人の<wbr>IPアドレス</th><th></th></tr></thead>
            <tbody id="uploads-body"></tbody>
          </table></div>
          <button type="button" class="link more" id="uploads-more" hidden></button>
          <p class="hint">「詳しく」で、SHA-256や部屋の鍵などをすべて出し、そこから消したりBANしたりできます。置いた人は、記録（7日分）に残っているものだけを出します。「この部屋から消す」は、その部屋の1つだけを消します。部屋にいる人が手元に持っていれば、また置かれます。違法なものや権利を侵すものは「消して二度と置かせない」で、置いてあるすべての部屋から消し、どの部屋にも置けなくします。</p>
        </section>
        <section class="card">
          <h2>場所を多く使っている部屋</h2>
          <div class="scroll"><table>
            <thead><tr><th>部屋</th><th>部屋の鍵</th><th class="num">件数</th><th class="num">大きさ</th><th class="num" id="usage-share" hidden></th><th></th></tr></thead>
            <tbody id="usage-body"></tbody>
          </table></div>
        </section>
        <section class="card">
          <h2>二度と置かせないもの</h2>
          <p class="hint">ここにあるIDの画像と音声は、どの部屋にも置けません。IDは中身から決まるので、同じ画像はだれが置こうとしても断ります。</p>
          <div class="scroll"><table>
            <thead><tr><th>ID</th><th></th></tr></thead>
            <tbody id="blocked-body"></tbody>
          </table></div>
        </section>
      </div>
      <div id="tab-activity" role="tabpanel" hidden>
        <section class="card">
                <div class="toolbar">
                  <select id="activity-kind" aria-label="種類">
                    <option value="">すべて</option>
                    <option value="login">ログイン</option>
                    <option value="room">部屋を作った</option>
                    <option value="upload">画像と音声を置いた</option>
                    <option value="limited">回数の制限</option>
                    <option value="refused">BANで断った</option>
                    <option value="admin">管理</option>
                  </select>
                  <input type="search" id="activity-search" placeholder="IPアドレス・Discord ID・名前・部屋で絞り込む" aria-label="絞り込み">
                  <span class="muted" id="activity-summary"></span>
                  <span class="spacer"></span>
                  <button type="button" id="activity-csv">CSVで保存</button>
                </div>
                <div class="scroll"><table>
                  <thead><tr id="activity-head"></tr></thead>
                  <tbody id="activity-body"></tbody>
                </table></div>
    
        </section>
      </div>
      <div id="tab-bans" role="tabpanel" hidden>
        <section class="card">
                <form class="ban" id="ban-form">
                  <label>種類
                    <select id="ban-kind"><option value="ip">IPアドレス</option><option value="discord">Discord ID</option></select>
                  </label>
                  <label class="wide">対象
                    <input id="ban-value" required maxlength="64" placeholder="203.0.113.5、203.0.113.0/24、2001:db8::/48、Discord ID">
                  </label>
                  <label>期間
                    <select id="ban-hours">
                      <option value="1">1時間</option>
                      <option value="24">1日</option>
                      <option value="168" selected>7日</option>
                      <option value="720">30日</option>
                      <option value="">解除するまで</option>
                    </select>
                  </label>
                  <label class="wide">理由（自分のための控え）
                    <input id="ban-reason" maxlength="200">
                  </label>
                  <label class="check"><input type="checkbox" id="ban-rooms">この対象が作った部屋も削除する（入っている人の接続は切れ、卓と画像と音声は消えます）</label>
                  <button class="primary" id="ban-submit">BANする</button>
                </form>
                <p class="hint">IPv6のアドレスは、/を付けなければ先頭の/64をまとめてBANします。BANすると、部屋に入っている接続を切り、部屋に入る・部屋を作る・画像と音声を置く・ログイン・トークンの更新を、押したときからすべてのインスタンスで止めます。部屋の一覧や画像を読むなどのほかのリクエストは、ほかのインスタンスで最大30秒遅れて止まります。</p>
      
        </section>
        <section class="card">
          <div class="toolbar">
                  <span class="muted" id="bans-summary"></span>
                  <span class="spacer"></span>
                  <button type="button" id="bans-csv">CSVで保存</button>
                </div>
                <div class="scroll"><table>
                  <thead><tr><th>種類</th><th>対象</th><th>理由</th><th>BANした<wbr>時刻</th><th>終わる<wbr>時刻</th><th>残り</th><th></th></tr></thead>
                  <tbody id="bans-body"></tbody>
                </table></div>
    
        </section>
      </div>
      <div id="tab-accounts" role="tabpanel" hidden>
        <section class="card">
          <h2>アカウントを調べる</h2>
          <form class="toolbar" id="account-form">
            <input id="account-id" inputmode="numeric" maxlength="20" placeholder="DiscordのユーザーID" aria-label="DiscordのユーザーID">
            <button class="primary">調べる</button>
          </form>
          <div id="account-result"></div>
          <p class="hint">参加する人から、アカウントを消してほしいと言われたときに使います。Discord IDは、記録や「目立つアカウント」から分かります。</p>
        </section>
      </div>
      <div id="tab-security" role="tabpanel" hidden>
        <section class="card">
          <h2>緊急停止</h2>
          <p class="hint">コストアタックや荒らしが止まらないときに、選んだことを、すべての人について止めます。押したときから、すべてのインスタンスで止まります。いま部屋で遊んでいる人と、ログインしたままの人は、そのまま使えます。</p>
          <div class="pause-kinds">
            <label><input type="checkbox" id="pause-rooms">部屋を作る</label>
            <label><input type="checkbox" id="pause-uploads">画像と音声を置く</label>
            <label><input type="checkbox" id="pause-logins">新しくログインする</label>
          </div>
          <p id="pause-state"></p>
          <div class="toolbar">
            <button type="button" class="danger" id="pause-apply">チェックしたものだけを止める</button>
            <button type="button" id="pause-resume">すべて再開する</button>
          </div>
        </section>
        <section class="card">
          <h2>回数の上限を締める</h2>
          <p class="hint">緊急停止するほどではないが、回数の上限を超える送信元が多いときに、上限を一時的に厳しくします。1/2にすると、1つの送信元が1分にできる回数が半分になります。押したインスタンスではすぐに、ほかのインスタンスには30秒ほどで行き渡ります。</p>
          <div class="tighten-kinds">
            <label>画像と音声を置く（ふつうは1分に100回）
              <select id="tighten-upload"><option value="1">ふつう</option><option value="2">1/2</option><option value="4">1/4</option><option value="10">1/10</option></select>
            </label>
            <label>読み出し（ふつうは1分に600回）
              <select id="tighten-read"><option value="1">ふつう</option><option value="2">1/2</option><option value="4">1/4</option><option value="10">1/10</option></select>
            </label>
            <label>部屋を作る・入る（ふつうは1分に30回）
              <select id="tighten-room"><option value="1">ふつう</option><option value="2">1/2</option><option value="4">1/4</option><option value="10">1/10</option></select>
            </label>
            <label>ログイン（ふつうは1分に60回）
              <select id="tighten-auth"><option value="1">ふつう</option><option value="2">1/2</option><option value="4">1/4</option><option value="10">1/10</option></select>
            </label>
          </div>
          <p id="tighten-state"></p>
          <div class="toolbar">
            <button type="button" class="danger" id="tighten-apply">この設定で締める</button>
            <button type="button" id="tighten-loosen">すべて元に戻す</button>
          </div>
        </section>
        <section class="card">
          <h2>パスキー</h2>
          <p class="hint">管理画面に入るときと、部屋の削除など戻せない操作の前に使います。端末を失くしたときのために、2つ以上の端末に登録しておいてください。</p>
          <div class="scroll"><table>
            <thead><tr><th>名前</th><th>種類</th><th>登録した<wbr>時刻</th><th>最後に使った<wbr>時刻</th><th></th></tr></thead>
            <tbody id="passkeys-body"></tbody>
          </table></div>
          <div class="toolbar add-passkey">
            <input id="passkey-add-name" maxlength="60" placeholder="この端末の名前" aria-label="この端末の名前">
            <button type="button" class="primary" id="passkey-add">この端末のパスキーを追加</button>
          </div>
        </section>
        <section class="card">
          <h2>ログイン</h2>
          <p id="session-state"></p>
          <p class="hint">ログインは、30分操作が無いか、Discordでログインしてから12時間たつと切れます。だれかにログインを盗まれたかもしれないときは、すべての人をログアウトさせてください。</p>
          <p><button type="button" class="danger" id="sessions-end">すべての人をログアウトさせる</button></p>
        </section>
      </div>
      <div id="tab-settings" role="tabpanel" hidden>
        <section class="card">
          <h2>いまの設定</h2>
          <p class="hint">秘密の値は出しません。変えるときは、部屋のサーバーを置いた先（CloudflareかVercel）の設定で変えてください。</p>
          <div id="settings-body"></div>
        </section>
      </div>
    </main>
  </div>
</div>
<dialog id="room-dialog">
  <div class="head"><h2 id="room-title"></h2><button type="button" id="room-close">閉じる</button></div>
  <div id="room-meta"></div>
  <section><h3>入っている人</h3><div id="room-seats"></div></section>
  <section><h3>画像と音声</h3><div id="room-assets"></div></section>
  <section><button type="button" class="danger" id="room-delete">この部屋を削除</button></section>
</dialog>
<dialog id="asset-dialog">
  <div class="head"><h2 id="asset-title"></h2><button type="button" id="asset-close">閉じる</button></div>
  <div id="asset-facts"></div>
  <div id="asset-body"></div>
  <div class="toolbar" id="asset-actions"></div>
</dialog>
`;

/** The page, with the nonce that lets its style and script run. */
export const adminPage = (nonce: string): string => `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>部屋のサーバーの管理</title>
<link rel="icon" href="data:,">
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>${BODY}<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>
`;

/** The policy for the page: nothing from elsewhere, and only what carries the nonce runs. */
export const adminPagePolicy = (nonce: string): string =>
  [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "img-src 'self' data: blob:",
    'media-src blob:',
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
