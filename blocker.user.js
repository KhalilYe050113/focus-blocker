// ==UserScript==
// @name         网站拦截器 · 专注守护
// @namespace    local.focus-blocker
// @version      1.1.7
// @description  拦截指定网站：命中立刻遮蔽并中止加载；分组可设全程 / 时段 / 强制三种策略，支持自定义时段与放行额度
// @author       Khalil
// @match        *://*/*
// @run-at       document-start
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
  'use strict';

  var KEY_CFG = 'apb.config.v1';
  var KEY_STATS = 'apb.stats.v1';
  var PASS_PREFIX = '__apb_pass__';
  var DAY = 86400000;
  var EST_MIN_PER_BLOCK = 6;

  var PRESETS = {
    '短视频': ['douyin.com', 'kuaishou.com', 'bilibili.com', 'youtube.com/shorts', 'xiaohongshu.com', 'ixigua.com', 'haokan.baidu.com'],
    '社交': ['weibo.com', 'x.com', 'twitter.com', 'zhihu.com', 'douban.com', 'tieba.baidu.com', 'reddit.com', 'instagram.com'],
    '游戏': ['steamcommunity.com', 'store.steampowered.com', 'epicgames.com', 'gcores.com', 'nga.cn'],
    '购物': ['taobao.com', 'tmall.com', 'jd.com', 'pinduoduo.com', 'yangkeduo.com', 'smzdm.com']
  };

  var DEFAULT_QUOTES = [
    '现在关掉它，手头的事还没做完。',
    '你不是没时间，是把时间给了这个页面。',
    '现在关掉它，晚上就不用还债。',
    '刷完这一条，什么也不会变。',
    '你想成为的那个人，不会在这个页面上等你。',
    '一次放行，要用两倍的专注还回去。',
    '真的现在就要看吗？半小时后再问自己一次。'
  ];

  var DEFAULT_CFG = {
    version: 1,
    enabled: true,
    pauseUntil: 0,
    rules: [],
    whitelist: [],
    groupMeta: {},
    groupPolicy: {},
    waitSeconds: 10,
    passMinutes: 5,
    requireReason: true,
    pinHash: '',
    quotes: DEFAULT_QUOTES.slice(),
    log: []
  };

  /* @pure-start */
  var SUFFIX2 = ['com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn', 'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
    'co.jp', 'ne.jp', 'or.jp', 'com.hk', 'com.tw', 'com.mo', 'com.sg', 'com.my', 'co.kr', 'com.au', 'net.au',
    'com.br', 'com.ru'];

  function baseDomain(host) {
    var h = String(host || '').toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
    if (!h) return '';
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return h;
    var parts = h.split('.');
    if (parts.length <= 2) return h;
    var last2 = parts.slice(-2).join('.');
    if (SUFFIX2.indexOf(last2) !== -1) return parts.slice(-3).join('.');
    return last2;
  }

  function normalizeRule(input) {
    var s = String(input == null ? '' : input).trim();
    if (!s) return null;
    s = s.replace(/^https?:\/\//i, '').replace(/^\/\//, '');
    if (s.length > 2 && s.charAt(0) === '/' && s.charAt(s.length - 1) === '/') {
      return { pattern: s.slice(1, -1), type: 'regex' };
    }
    s = s.toLowerCase().replace(/\/+$/, '');
    if (!s) return null;
    if (s.indexOf('*.') === 0) return { pattern: s.slice(2), type: 'wildcard' };
    if (s.indexOf('/') > 0) return { pattern: s.replace(/^www\./, ''), type: 'path' };
    return { pattern: s.replace(/^www\./, ''), type: 'domain' };
  }

  function hostMatch(host, pattern) {
    if (!pattern) return false;
    return host === pattern || host.slice(-(pattern.length + 1)) === '.' + pattern;
  }

  function matchPattern(rule, ctx) {
    if (!rule || !rule.pattern) return false;
    if (rule.enabled === false) return false;
    var p = rule.pattern;
    if (rule.type === 'regex') {
      try { return new RegExp(p, 'i').test(ctx.host + ctx.path); } catch (e) { return false; }
    }
    if (rule.type === 'path') {
      var i = p.indexOf('/');
      if (i < 0) return hostMatch(ctx.host, p);
      var h = p.slice(0, i);
      var path = p.slice(i);
      if (!hostMatch(ctx.host, h)) return false;
      var cur = ctx.path;
      return cur === path || cur.indexOf(path + '/') === 0 || cur.indexOf(path + '?') === 0;
    }
    return hostMatch(ctx.host, p);
  }
  /* @pure-end */

  function num(v, d) {
    var n = Number(v);
    return isFinite(n) ? n : d;
  }

  function clamp(v, a, b) {
    return Math.min(b, Math.max(a, v));
  }

  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  function ymd(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function fmtTime(ts) {
    var d = new Date(ts);
    return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function gmGet(key, dflt) {
    try {
      var v = GM_getValue(key);
      return typeof v === 'undefined' ? dflt : v;
    } catch (e) {
      return dflt;
    }
  }

  function gmSet(key, val) {
    try { GM_setValue(key, val); } catch (e) { /* ignore */ }
  }

  function fixRule(r) {
    if (!r) return null;
    if (typeof r === 'string') {
      var n = normalizeRule(r);
      if (!n) return null;
      return { pattern: n.pattern, type: n.type, group: '自定义', enabled: true, strict: false };
    }
    if (typeof r !== 'object' || !r.pattern) return null;
    var t = ['domain', 'wildcard', 'path', 'regex'].indexOf(r.type) >= 0 ? r.type : 'domain';
    return {
      pattern: String(r.pattern).toLowerCase(),
      type: t,
      group: r.group ? String(r.group) : '自定义',
      enabled: r.enabled !== false,
      strict: r.strict === true
    };
  }

  var cfg = null;
  var stats = null;
  var BLOCKED = false;
  var SPA_HOOKED = false;
  var HOTKEY_BOUND = false;
  var P = { root: null, sr: null, tab: 'list', open: false, filter: '', filterGroup: '', editGroup: null };

  function normPolicy(v) {
    v = (v && typeof v === 'object') ? v : {};
    return {
      mode: v.mode === 'window' ? 'window' : (v.mode === 'strict' ? 'strict' : 'always'),
      windows: Array.isArray(v.windows) ? v.windows.slice(0, 12) : [],
      days: Array.isArray(v.days) ? v.days.slice() : [1, 2, 3, 4, 5],
      allowPassInWindow: v.allowPassInWindow !== false,
      passMinutes: (v.passMinutes == null || v.passMinutes === '') ? null : clamp(num(v.passMinutes, 5), 1, 120),
      waitSeconds: (v.waitSeconds == null || v.waitSeconds === '') ? null : clamp(num(v.waitSeconds, 10), 0, 60),
      requireReason: (v.requireReason === true || v.requireReason === false) ? v.requireReason : null,
      dailyPassLimit: clamp(num(v.dailyPassLimit, 0), 0, 99)
    };
  }

  function loadCfg() {
    var raw = gmGet(KEY_CFG, null);
    var c = {};
    var k;
    for (k in DEFAULT_CFG) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_CFG, k)) c[k] = DEFAULT_CFG[k];
    }
    if (raw && typeof raw === 'object') {
      for (k in raw) {
        if (Object.prototype.hasOwnProperty.call(raw, k)) c[k] = raw[k];
      }
    }
    c.rules = (Array.isArray(c.rules) ? c.rules : []).map(fixRule).filter(Boolean);
    c.whitelist = (Array.isArray(c.whitelist) ? c.whitelist : []).map(fixRule).filter(Boolean);
    if (!c.groupMeta || typeof c.groupMeta !== 'object') c.groupMeta = {};
    var gpSrc = (c.groupPolicy && typeof c.groupPolicy === 'object') ? c.groupPolicy : {};
    var gp = {};
    Object.keys(gpSrc).forEach(function (k) {
      gp[k] = normPolicy(gpSrc[k]);
    });
    c.groupPolicy = gp;
    c.rules.forEach(function (r) {
      if (r.strict !== true) return;
      var gname = r.group || '自定义';
      if (!gp[gname]) gp[gname] = normPolicy(null);
      gp[gname].mode = 'strict';
      delete r.strict;
    });
    if (!Array.isArray(c.quotes) || !c.quotes.length) c.quotes = DEFAULT_QUOTES.slice();
    if (!Array.isArray(c.log)) c.log = [];
    c.waitSeconds = clamp(num(c.waitSeconds, 10), 0, 60);
    c.passMinutes = clamp(num(c.passMinutes, 5), 1, 120);
    c.enabled = c.enabled !== false;
    c.requireReason = c.requireReason !== false;
    return c;
  }

  function saveCfg() {
    gmSet(KEY_CFG, cfg);
  }

  function loadStats() {
    var raw = gmGet(KEY_STATS, null);
    var s = (raw && typeof raw === 'object') ? raw : {};
    if (!s.days || typeof s.days !== 'object') s.days = {};
    s.total = num(s.total, 0);
    return s;
  }

  function saveStats() {
    gmSet(KEY_STATS, stats);
  }

  function pruneStats() {
    var keys = Object.keys(stats.days).sort();
    while (keys.length > 120) {
      delete stats.days[keys.shift()];
    }
  }

  function recordBlock(host) {
    var k = ymd();
    var d = stats.days[k];
    if (!d || typeof d !== 'object') {
      d = { blocks: 0, domains: {} };
      stats.days[k] = d;
    }
    if (!d.domains || typeof d.domains !== 'object') d.domains = {};
    d.blocks = num(d.blocks, 0) + 1;
    d.domains[host] = num(d.domains[host], 0) + 1;
    stats.total = num(stats.total, 0) + 1;
    pruneStats();
    saveStats();
    return d.blocks;
  }

  function weekBlocks() {
    var sum = 0;
    for (var i = 0; i < 7; i++) {
      var k = ymd(new Date(Date.now() - i * DAY));
      if (stats.days[k]) sum += num(stats.days[k].blocks, 0);
    }
    return sum;
  }

  function streakDays() {
    var today = ymd();
    if (!stats.days[today]) return 0;
    var passDays = {};
    (cfg.log || []).forEach(function (x) {
      if (x && x.ts) passDays[ymd(new Date(x.ts))] = true;
    });
    if (passDays[today]) return 0;
    var n = 1;
    for (var i = 1; i < 365; i++) {
      var k = ymd(new Date(Date.now() - i * DAY));
      if (!stats.days[k] || passDays[k]) break;
      n++;
    }
    return n;
  }

  function fmtSaved(blocks) {
    var mins = blocks * EST_MIN_PER_BLOCK;
    if (mins < 60) return mins + ' 分';
    return (Math.round(mins / 6) / 10) + ' 小时';
  }

  function ruleHost(r) {
    if (!r || r.type === 'regex') return '';
    var i = r.pattern.indexOf('/');
    return i > 0 ? r.pattern.slice(0, i) : r.pattern;
  }

  function groupOff(name) {
    var m = cfg.groupMeta && cfg.groupMeta[name];
    return !!(m && m.off);
  }

  function groupMode(g) {
    var name = g || '自定义';
    var p = cfg.groupPolicy && cfg.groupPolicy[name];
    return (p && p.mode) ? p.mode : 'always';
  }

  function policyOf(g) {
    var name = g || '自定义';
    var p = cfg.groupPolicy && cfg.groupPolicy[name];
    if (p) return p;
    return {
      mode: groupMode(name),
      windows: [],
      days: [1, 2, 3, 4, 5],
      allowPassInWindow: true,
      passMinutes: null,
      waitSeconds: null,
      requireReason: null,
      dailyPassLimit: 0
    };
  }

  function isStrictRule(r) {
    return groupMode(r.group) === 'strict';
  }

  function policyText(g) {
    var m = groupMode(g);
    if (m === 'strict') return '强制，不可放行';
    if (m === 'window') {
      var p = policyOf(g);
      return '时段 ' + (p.windows.length ? p.windows.join(' / ') : '未设置') + ' 拦截';
    }
    return '全程拦截';
  }

  function toMin(s) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(s == null ? '' : s).trim());
    if (!m) return -1;
    var h = Number(m[1]);
    var mi = Number(m[2]);
    if (h > 23 || mi > 59) return -1;
    return h * 60 + mi;
  }

  function inWindow(p, now) {
    var d = now || new Date();
    var days = (p && Array.isArray(p.days) && p.days.length) ? p.days : [0, 1, 2, 3, 4, 5, 6];
    var ws = (p && Array.isArray(p.windows)) ? p.windows : [];
    if (!ws.length) return false;
    var cur = d.getHours() * 60 + d.getMinutes();
    var today = d.getDay();
    var yest = (today + 6) % 7;
    for (var i = 0; i < ws.length; i++) {
      var parts = String(ws[i]).split('-');
      if (parts.length !== 2) continue;
      var a = toMin(parts[0]);
      var b = toMin(parts[1]);
      if (a < 0 || b < 0 || a === b) continue;
      if (a < b) {
        if (days.indexOf(today) >= 0 && cur >= a && cur < b) return true;
      } else {
        if (days.indexOf(today) >= 0 && cur >= a) return true;
        if (days.indexOf(yest) >= 0 && cur < b) return true;
      }
    }
    return false;
  }

  function shouldBlockNow(r) {
    var mode = groupMode(r.group);
    if (mode === 'strict') return true;
    if (mode === 'window') return inWindow(policyOf(r.group));
    return true;
  }

  function passCountToday(g) {
    var today = ymd();
    var n = 0;
    (cfg.log || []).forEach(function (x) {
      if (!x || !x.ts) return;
      if (ymd(new Date(x.ts)) !== today) return;
      var gg = x.group || hostGroup(x.domain || '');
      if (gg === g) n++;
    });
    return n;
  }

  function effPass(r) {
    var p = policyOf(r.group);
    return {
      minutes: p.passMinutes == null ? cfg.passMinutes : p.passMinutes,
      wait: p.waitSeconds == null ? cfg.waitSeconds : p.waitSeconds,
      reason: p.requireReason == null ? cfg.requireReason : p.requireReason,
      allow: groupMode(r.group) === 'strict' ? false : (groupMode(r.group) === 'window' ? p.allowPassInWindow !== false : true),
      limit: p.dailyPassLimit || 0
    };
  }

  function ruleActive(r) {
    if (isStrictRule(r)) return true;
    if (r.enabled === false) return false;
    return !groupOff(r.group || '自定义');
  }

  function inheritGroup(n) {
    var base = baseDomain(ruleHost({ pattern: n.pattern, type: n.type }));
    if (!base) return '';
    for (var i = 0; i < cfg.rules.length; i++) {
      var h = ruleHost(cfg.rules[i]);
      if (h && baseDomain(h) === base) return cfg.rules[i].group || '';
    }
    return '';
  }

  function ruleCoversHost(r, host) {
    if (r.type === 'regex') {
      try { return new RegExp(r.pattern, 'i').test(host + '/'); } catch (e) { return false; }
    }
    var h = ruleHost(r);
    return h ? hostMatch(host, h) : false;
  }

  function hostGroup(host) {
    var i;
    for (i = 0; i < cfg.rules.length; i++) {
      if (isStrictRule(cfg.rules[i]) && ruleActive(cfg.rules[i]) && ruleCoversHost(cfg.rules[i], host)) {
        return cfg.rules[i].group || '自定义';
      }
    }
    for (i = 0; i < cfg.rules.length; i++) {
      if (!isStrictRule(cfg.rules[i]) && ruleActive(cfg.rules[i]) && ruleCoversHost(cfg.rules[i], host)) {
        return cfg.rules[i].group || '自定义';
      }
    }
    return '未分组';
  }

  function findStrictHit() {
    var ctx = {
      host: String(location.hostname || '').toLowerCase(),
      path: location.pathname + location.search,
      href: location.href
    };
    for (var i = 0; i < cfg.rules.length; i++) {
      if (isStrictRule(cfg.rules[i]) && ruleActive(cfg.rules[i]) && matchPattern(cfg.rules[i], ctx)) return cfg.rules[i];
    }
    return null;
  }

  function findHit() {
    var ctx = {
      host: String(location.hostname || '').toLowerCase(),
      path: location.pathname + location.search,
      href: location.href
    };
    var i;
    for (i = 0; i < cfg.rules.length; i++) {
      if (isStrictRule(cfg.rules[i]) && ruleActive(cfg.rules[i]) && matchPattern(cfg.rules[i], ctx)) return cfg.rules[i];
    }
    for (i = 0; i < cfg.whitelist.length; i++) {
      if (matchPattern(cfg.whitelist[i], ctx)) return null;
    }
    for (i = 0; i < cfg.rules.length; i++) {
      var r = cfg.rules[i];
      if (!isStrictRule(r) && ruleActive(r) && shouldBlockNow(r) && matchPattern(r, ctx)) return r;
    }
    return null;
  }

  function getPass(host) {
    try {
      var v = sessionStorage.getItem(PASS_PREFIX + host);
      return v ? Number(v) : 0;
    } catch (e) {
      return 0;
    }
  }

  function setPass(host, exp) {
    try { sessionStorage.setItem(PASS_PREFIX + host, String(exp)); } catch (e) { /* ignore */ }
  }

  function clearPass(host) {
    try { sessionStorage.removeItem(PASS_PREFIX + host); } catch (e) { /* ignore */ }
  }

  function isTopFrame() {
    try { return window.top === window.self; } catch (e) { return false; }
  }

  var BLOCK_CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;margin:0;padding:0}',
    '.wrap{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:56px 24px;background:#0e1014;color:#e8eaed;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;text-align:center}',
    '.badge{font-size:12px;letter-spacing:2px;color:#f09595;border:1px solid #5a2226;background:#1b1214;border-radius:999px;padding:5px 14px}',
    '.badge.hard{color:#ffd7d7;border-color:#a32d2d;background:#2a1214}',
    'h1{font-size:clamp(24px,4vw,34px);font-weight:500;letter-spacing:-.5px;margin:20px 0 10px;word-break:break-all;line-height:1.25}',
    '.meta{font-size:13px;color:#9aa3b2;line-height:1.7;max-width:540px;word-break:break-word}',
    '.meta.sub{font-size:12px;color:#6f7887;margin-top:-2px}',
    '.quote{max-width:540px;width:100%;margin:28px 0 0;padding:16px 20px;border-left:2px solid #2f8f74;background:#14181f;border-radius:0 10px 10px 0;text-align:left}',
    '.quote p{font-size:14px;line-height:1.7}',
    '.quote span{display:block;font-size:12px;color:#6f7887;margin-top:6px}',
    '.acts{display:flex;gap:10px;margin:28px 0 0;flex-wrap:wrap;justify-content:center}',
    'button{font:inherit;cursor:pointer;border-radius:8px;padding:9px 20px;font-size:13px;border:1px solid #2c3340;background:#161b23;color:#cfd6e0}',
    'button:hover{background:#1c222c}',
    'button.primary{background:#1b3a30;border-color:#2f8f74;color:#bdf0dd}',
    'button.primary:hover{background:#21453a}',
    'button:disabled{opacity:.45;cursor:not-allowed}',
    '.tip{font-size:12px;color:#6f7887;margin:16px 0 0;line-height:1.6}',
    '.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:34px 0 0;width:100%;max-width:540px}',
    '.stat{background:#14181f;border:1px solid #212734;border-radius:10px;padding:12px}',
    '.stat b{display:block;font-size:19px;font-weight:500;margin-top:4px}',
    '.stat i{font-style:normal;font-size:12px;color:#828b9a}',
    '.foot{font-size:11px;color:#4e5665;margin:30px 0 0}',
    '.reason{width:100%;max-width:540px;margin:26px 0 0;text-align:left}',
    'textarea{width:100%;min-height:72px;resize:vertical;background:#14181f;border:1px solid #2c3340;border-radius:8px;color:#e8eaed;font:inherit;font-size:13px;padding:10px 12px;outline:none}',
    'textarea:focus{border-color:#2f8f74}'
  ].join('');

  function pickQuote() {
    var list = cfg.quotes && cfg.quotes.length ? cfg.quotes : DEFAULT_QUOTES;
    var seed = Number(ymd().replace(/-/g, '')) || 1;
    return list[seed % list.length];
  }

  function mountBlockPage(rule, count) {
    var host = String(location.hostname || '').toLowerCase();
    var group = rule && rule.group ? rule.group : '';
    var pattern = rule && rule.pattern ? rule.pattern : host;
    var strict = !!(rule && isStrictRule(rule));
    var eff = rule ? effPass(rule) : { minutes: cfg.passMinutes, wait: cfg.waitSeconds, reason: cfg.requireReason, allow: true, limit: 0 };
    var usedToday = rule ? passCountToday(rule.group || '自定义') : 0;
    var quotaOut = eff.limit > 0 && usedToday >= eff.limit;
    var canPass = !strict && eff.allow && !quotaOut;
    var waitS = eff.wait;
    var passMin = eff.minutes;

    var de = document.documentElement;
    var attrs = Array.prototype.slice.call(de.attributes);
    attrs.forEach(function (a) {
      try { de.removeAttribute(a.name); } catch (e) { /* ignore */ }
    });
    while (de.firstChild) de.removeChild(de.firstChild);
    de.style.cssText = 'background:#0e1014!important;';

    var head = document.createElement('head');
    var cs = document.createElement('meta');
    cs.setAttribute('charset', 'utf-8');
    head.appendChild(cs);
    var vp = document.createElement('meta');
    vp.setAttribute('name', 'viewport');
    vp.setAttribute('content', 'width=device-width,initial-scale=1');
    head.appendChild(vp);
    var ti = document.createElement('title');
    ti.textContent = '已拦截 · ' + host;
    head.appendChild(ti);
    de.appendChild(head);

    var body = document.createElement('body');
    body.style.cssText = 'margin:0;padding:0;';
    de.appendChild(body);

    var root = document.createElement('div');
    root.setAttribute('data-apb', 'block');
    root.style.cssText = 'all:initial;position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483646;';
    var sr = root.attachShadow({ mode: 'closed' });

    var html = '<style>' + BLOCK_CSS + '</style><div class="wrap">';
    html += '<div class="badge' + (strict ? ' hard' : '') + '">' + (strict ? '永久禁用' : '已拦截') + '</div>';
    html += '<h1>' + esc(host) + '</h1>';
    html += '<p class="meta">今天第 ' + count + ' 次尝试打开 · 规则 ' + esc(pattern) + '</p>';
    if (group) html += '<p class="meta sub">' + esc(group) + ' · ' + esc(policyText(group)) + '</p>';
    html += '<div class="quote"><p>' + esc(pickQuote()) + '</p><span>你写给自己的</span></div>';
    html += '<div class="acts" id="acts">';
    html += '<button class="primary" id="back">回去工作</button>';
    if (canPass) html += '<button id="pass" disabled>限时放行</button>';
    html += '</div>';
    if (canPass) {
      html += '<div class="reason" id="reasonwrap" style="display:none">';
      html += '<textarea id="reason" placeholder="一句话说明为什么要放行，会记入日志"></textarea>';
      html += '<div class="acts"><button class="primary" id="confirm">确认放行 ' + passMin + ' 分钟</button><button id="cancel">算了</button></div>';
      html += '</div>';
    }
    var tipTxt;
    if (strict) {
      tipTxt = '这个站点被设为永久禁用，没有放行入口，也不会因为等待而解禁。';
    } else if (!eff.allow) {
      tipTxt = '当前分组设了「时段内不放行」，放行入口是关掉的。';
    } else if (quotaOut) {
      tipTxt = '今天的放行次数已经用完（' + usedToday + ' / ' + eff.limit + '），明天再说。';
    } else {
      tipTxt = '放行需等待 ' + waitS + ' 秒' + (eff.reason ? '并填写一句理由' : '') + '，会记入日志';
    }
    html += '<p class="tip" id="tip">' + tipTxt + '</p>';
    html += '<div class="stats">';
    html += '<div class="stat"><i>今日拦截</i><b>' + count + ' 次</b></div>';
    html += '<div class="stat"><i>本周约省下</i><b>' + fmtSaved(weekBlocks()) + '</b></div>';
    html += '<div class="stat"><i>连续守规</i><b>' + streakDays() + ' 天</b></div>';
    html += '</div>';
    html += '<p class="foot">Alt + Shift + B 打开设置面板</p>';
    html += '</div>';
    sr.innerHTML = html;
    body.appendChild(root);

    try { document.title = (strict ? '已禁用 · ' : '已拦截 · ') + host; } catch (e) { /* ignore */ }

    var passBtn = sr.getElementById('pass');
    var tip = sr.getElementById('tip');
    var acts = sr.getElementById('acts');
    var reasonWrap = sr.getElementById('reasonwrap');
    var remain = Math.max(0, Math.round(waitS));

    function tick() {
      if (!passBtn || !passBtn.isConnected) return;
      if (remain > 0) {
        passBtn.disabled = true;
        passBtn.textContent = '限时放行（' + remain + 's）';
        remain--;
        setTimeout(tick, 1000);
      } else {
        passBtn.disabled = false;
        passBtn.textContent = '限时放行 ' + passMin + ' 分钟';
        tip.textContent = '放行后 ' + passMin + ' 分钟内不再拦截，可随时收回';
      }
    }
    if (passBtn) tick();

    sr.getElementById('back').addEventListener('click', function () {
      try { window.close(); } catch (e) { /* ignore */ }
      setTimeout(function () {
        if (history.length > 1) {
          history.back();
        } else {
          location.replace('about:blank');
        }
      }, 140);
    });

    if (passBtn && acts && reasonWrap) {
      passBtn.addEventListener('click', function () {
        acts.style.display = 'none';
        reasonWrap.style.display = 'block';
        var t = sr.getElementById('reason');
        if (t) t.focus();
      });

      sr.getElementById('cancel').addEventListener('click', function () {
        reasonWrap.style.display = 'none';
        acts.style.display = 'flex';
      });

      sr.getElementById('confirm').addEventListener('click', function () {
        var t = sr.getElementById('reason');
        var reason = t ? t.value.trim() : '';
        if (eff.reason && !reason) {
          if (t) {
            t.style.borderColor = '#7a2b2f';
            t.focus();
          }
          tip.textContent = '写一句理由再走，哪怕只有四个字。';
          return;
        }
        var ms = passMin * 60000;
        setPass(host, Date.now() + ms);
        cfg.log.unshift({ ts: Date.now(), domain: host, reason: reason || '（未填）', minutes: passMin, group: group });
        if (cfg.log.length > 300) cfg.log.length = 300;
        saveCfg();
        location.reload();
      });
    }

    var hardening = false;
    function harden() {
      if (hardening) return;
      hardening = true;
      try {
        var kids = Array.prototype.slice.call(de.children);
        for (var i = 0; i < kids.length; i++) {
          if (kids[i] !== head && kids[i] !== body && !kids[i].hasAttribute('data-apb')) {
            try { kids[i].remove(); } catch (e) { /* ignore */ }
          }
        }
        if (!head.isConnected) de.insertBefore(head, de.firstChild);
        if (!body.isConnected) de.appendChild(body);
        if (!root.isConnected) body.appendChild(root);
        var extra = Array.prototype.slice.call(body.children);
        for (var j = 0; j < extra.length; j++) {
          if (extra[j] !== root && !extra[j].hasAttribute('data-apb')) {
            try { extra[j].remove(); } catch (e) { /* ignore */ }
          }
        }
      } catch (e) { /* ignore */ }
      setTimeout(function () { hardening = false; }, 0);
    }
    var mo = new MutationObserver(harden);
    mo.observe(de, { childList: true, subtree: true });

    setTimeout(function () { try { window.stop(); } catch (e) { /* ignore */ } }, 60);
  }

  function fallbackPlain(host) {
    try {
      document.documentElement.innerHTML = '<body style="margin:0;background:#0e1014;color:#e8eaed;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><div style="text-align:center"><div style="font-size:13px;color:#f09595">已拦截</div><div style="font-size:28px;margin:12px 0">' + esc(host) + '</div><div style="font-size:13px;color:#9aa3b2">回去工作吧</div></div></body>';
    } catch (e) { /* ignore */ }
  }

  function hideEarly() {
    try {
      var st = document.createElement('style');
      st.setAttribute('data-apb', 'hide');
      st.textContent = 'html{visibility:hidden!important;background:#0e1014!important}';
      (document.head || document.documentElement).appendChild(st);
    } catch (e) { /* ignore */ }
  }

  function stopLoading() {
    try { window.stop(); } catch (e) { /* ignore */ }
    setTimeout(function () { try { window.stop(); } catch (e) { /* ignore */ } }, 0);
    setTimeout(function () { try { window.stop(); } catch (e) { /* ignore */ } }, 80);
  }

  function blockNow(rule) {
    if (BLOCKED) return;
    BLOCKED = true;
    hideEarly();
    try { window.stop(); } catch (e) { /* ignore */ }
    var count = 1;
    try { count = recordBlock(baseDomain(location.hostname)); } catch (e) { /* ignore */ }
    var host = String(location.hostname || '').toLowerCase();
    function paint() {
      try {
        mountBlockPage(rule, count);
        stopLoading();
      } catch (e) {
        fallbackPlain(host);
      }
    }
    if (document.documentElement) paint();
    else setTimeout(paint, 10);
  }

  function showPassBadge(exp) {
    var host = document.createElement('div');
    host.setAttribute('data-apb', 'pass');
    host.style.cssText = 'all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483646;';
    var sr = host.attachShadow({ mode: 'closed' });
    sr.innerHTML = '<style>' +
      ':host{all:initial}*{box-sizing:border-box}' +
      'button{font:13px -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;cursor:pointer;border:1px solid #2f8f74;background:#122019;color:#9fe1cb;border-radius:999px;padding:7px 14px;opacity:.9;box-shadow:0 2px 10px rgba(0,0,0,.3)}' +
      'button:hover{opacity:1}' +
      '</style><button id="b">放行中</button>';
    var btn = sr.getElementById('b');
    document.documentElement.appendChild(host);

    function tick() {
      var left = exp - Date.now();
      if (left <= 0) {
        if (host.isConnected) host.remove();
        try { location.reload(); } catch (e) { /* ignore */ }
        return;
      }
      var s = Math.ceil(left / 1000);
      var m = Math.floor(s / 60);
      var r = s % 60;
      btn.textContent = '放行中 ' + m + ':' + (r < 10 ? '0' + r : r) + ' · 收回';
      setTimeout(tick, 1000);
    }
    tick();

    btn.addEventListener('click', function () {
      clearPass(String(location.hostname || '').toLowerCase());
      location.reload();
    });
  }

  function installSpaGuard() {
    if (SPA_HOOKED) return;
    SPA_HOOKED = true;
    function fire() {
      try {
        if (!cfg.enabled) return;
        if (cfg.pauseUntil && Date.now() < cfg.pauseUntil) {
          var sp = findStrictHit();
          if (sp) blockNow(sp);
          return;
        }
        var hit = findHit();
        if (!hit) return;
        if (!isStrictRule(hit) && getPass(location.hostname) > Date.now()) return;
        blockNow(hit);
      } catch (e) { /* ignore */ }
    }
    try {
      ['pushState', 'replaceState'].forEach(function (k) {
        var orig = history[k];
        if (typeof orig !== 'function') return;
        history[k] = function () {
          var r = orig.apply(this, arguments);
          setTimeout(fire, 0);
          return r;
        };
      });
      window.addEventListener('popstate', fire);
      window.addEventListener('hashchange', fire);
      var lastHref = location.href;
      setInterval(function () {
        try {
          if (location.href !== lastHref) {
            lastHref = location.href;
            fire();
          }
        } catch (e) { /* ignore */ }
      }, 2000);
    } catch (e) { /* ignore */ }
  }

  function installHotkey() {
    if (HOTKEY_BOUND) return;
    HOTKEY_BOUND = true;
    document.addEventListener('keydown', function (e) {
      if (e.altKey && e.shiftKey && (e.key === 'B' || e.key === 'b')) {
        e.preventDefault();
        openPanel();
      }
    }, true);
  }

  var PANEL_CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;margin:0;padding:0}',
    '.bg{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(6,8,12,.74);display:flex;align-items:center;justify-content:center;padding:20px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}',
    '.card{width:100%;max-width:760px;max-height:min(88vh,780px);background:#12151b;border:1px solid #262b36;border-radius:14px;display:flex;flex-direction:column;color:#e8eaed;overflow:hidden}',
    '.head{display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid #212734}',
    '.head .t{font-size:15px;font-weight:500}',
    '.head .s{font-size:12px;color:#6f7887}',
    '.grow{flex:1}',
    '.tabs{display:flex;gap:4px;padding:8px 16px 0;border-bottom:1px solid #212734}',
    '.tab{border:0;background:transparent;color:#828b9a;font:13px inherit;padding:8px 14px;border-bottom:2px solid transparent;border-radius:6px 6px 0 0;cursor:pointer}',
    '.tab:hover{color:#cfd6e0;background:#171b22}',
    '.tab.on{color:#bdf0dd;border-bottom-color:#2f8f74}',
    '.body{padding:18px 20px 24px;overflow:auto;flex:1}',
    '.sec{margin-top:20px}',
    '.sec:first-child{margin-top:0}',
    '.sec-h{font-size:12px;color:#828b9a;margin-bottom:8px;letter-spacing:.5px}',
    '.sec-h b{color:#bdf0dd;font-weight:500}',
    '.row-add{display:flex;gap:8px}',
    'input,textarea,select{font:13px inherit;color:#e8eaed;background:#0e1116;border:1px solid #2c3340;border-radius:8px;padding:8px 11px;outline:none;width:100%}',
    'input:focus,textarea:focus{border-color:#2f8f74}',
    'input[type=checkbox]{width:auto;accent-color:#2f8f74}',
    'button{font:13px inherit;cursor:pointer;border:1px solid #2c3340;background:#161b23;color:#cfd6e0;border-radius:8px;padding:8px 14px;white-space:nowrap}',
    'button:hover{background:#1c222c}',
    'button.pri{background:#1b3a30;border-color:#2f8f74;color:#bdf0dd}',
    'button.pri:hover{background:#21453a}',
    'button.mini{padding:4px 9px;font-size:12px}',
    'button.danger{color:#f09595;border-color:#4a2226}',
    'button.danger:hover{background:#241417}',
    '.hint{font-size:12px;color:#5d6573;margin-top:8px;line-height:1.6}',
    '.items{margin-top:10px;display:flex;flex-direction:column;gap:6px}',
    '.item{display:grid;grid-template-columns:82px minmax(0,1fr) 64px 60px;gap:10px;align-items:center;background:#0e1116;border:1px solid #1e2430;border-radius:8px;padding:7px 10px}',
    '.item .pat{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.item .tag{position:relative;font-size:11px;color:#8b93a1;background:#181d26;border-radius:4px;padding:2px 7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center}',
    '.item .tag.hard{color:#cfd6e0;padding-left:12px;text-align:left}',
    '.item .tag.hard::before{content:"";position:absolute;left:4px;top:50%;margin-top:-5px;width:3px;height:10px;background:#e24b4a;border-radius:2px}',
    '.item.off .pat{color:#5d6573;text-decoration:line-through}',
    '.st{display:block;font:11px/20px inherit;height:22px;text-align:center;border-radius:6px;border:1px solid #2c3340;background:transparent;color:#cfd6e0;padding:0 2px;white-space:nowrap;overflow:hidden;cursor:pointer}',
    '.st-on{color:#9fe1cb;border-color:#2f8f74;background:#122019}',
    '.st-off{color:#828b9a}',
    '.st-lock{color:#f09595;border-color:#4a2226;background:#241417;cursor:default}',
    '.st-del{color:#cfd6e0}',
    '.st-del:hover{color:#f09595;border-color:#4a2226;background:#241417}',
    '.sitrow{display:flex;align-items:center;gap:8px;background:#0e1116;border:1px solid #1e2430;border-radius:8px;padding:7px 10px;font-size:12px}',
    '.mode{font-size:10px;line-height:16px;padding:0 6px;border-radius:4px;white-space:nowrap;border:1px solid transparent}',
    '.m-strict{color:#f09595;background:#241417;border-color:#4a2226}',
    '.m-window{color:#fac775;background:#241c0f;border-color:#5a4318}',
    '.m-always{color:#828b9a;background:#181d26;border-color:#212734}',
    '.pcard{background:#0e1116;border:1px solid #1e2430;border-radius:10px;padding:10px 12px;margin-top:8px}',
    '.prow{display:grid;grid-template-columns:88px minmax(0,1fr) 64px;gap:10px;align-items:center}',
    '.pname{font-size:13px;color:#e8eaed;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.psum{font-size:12px;color:#828b9a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.pedit{margin-top:12px;padding-top:12px;border-top:1px solid #1b202a}',
    '.plabel{font-size:11px;color:#828b9a;margin-bottom:6px}',
    '.wrow{display:flex;align-items:center;gap:8px;margin-top:6px}',
    '.wrow input[type=time]{flex:0 0 104px;width:104px}',
    '.wrow .dash{color:#5d6573;font-size:12px}',
    '.pgrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}',
    '.pf{display:flex;align-items:center;gap:6px;font-size:12px;color:#828b9a}',
    '.pf input{min-width:0}',
    '.pf i{font-style:normal;font-size:11px;color:#5d6573}',
    '.pcheck{font-size:12px;color:#cfd6e0;margin-top:8px}',
    '.pcheck label{display:flex;align-items:center;gap:6px}',
    '.pcheck select{width:auto}',
    '.dchip{width:28px;padding:4px 0;text-align:center}',
    '.chips{display:flex;gap:8px;flex-wrap:wrap}',
    '.chip{padding:5px 11px;font-size:12px;border-radius:999px}',
    '.chip.on{background:#1b3a30;border-color:#2f8f74;color:#bdf0dd}',
    '.ghead{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#161b23;border:1px solid #212734;border-radius:8px;margin-top:10px}',
    '.ghead .chev{border:0;background:transparent;color:#828b9a;padding:0;width:14px;font-size:12px;line-height:1}',
    '.ghead .chev:hover{background:transparent;color:#cfd6e0}',
    '.ghead .gname{font-size:13px;color:#e8eaed}',
    '.ghead .gcount{font-size:11px;color:#828b9a;background:#0e1116;border-radius:4px;padding:1px 6px}',
    '.ghead .goff{font-size:11px;color:#f09595}',
    '.grp .items{margin-top:6px;margin-left:12px}',
    '.grow-row{display:flex;align-items:center;gap:10px;padding:7px 0;font-size:12px}',
    '.grow-row .nm{width:78px;color:#cfd6e0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.grow-row .track{flex:1;height:6px;background:#0e1116;border-radius:3px;overflow:hidden}',
    '.grow-row .track i{display:block;height:100%;background:#2f8f74}',
    '.grow-row .vv{width:46px;text-align:right;color:#9aa3b2}',
    '.field{display:flex;align-items:center;gap:14px;padding:10px 0;border-bottom:1px solid #1b202a}',
    '.field label{font-size:13px;color:#cfd6e0;flex:0 0 150px}',
    '.field .ctl{flex:1;display:flex;align-items:center;gap:8px}',
    '.field .ctl input[type=number]{width:96px}',
    '.field .note{font-size:11px;color:#5d6573}',
    '.grid4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}',
    '.kv{background:#0e1116;border:1px solid #1e2430;border-radius:10px;padding:12px}',
    '.kv i{font-style:normal;font-size:11px;color:#828b9a}',
    '.kv b{display:block;font-size:20px;font-weight:500;margin-top:4px}',
    '.bars{display:flex;align-items:flex-end;gap:10px;height:110px;margin-top:14px;padding:0 2px}',
    '.bar{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:6px;height:100%}',
    '.bar .col{width:100%;background:#1b3a30;border:1px solid #2f8f74;border-radius:4px 4px 0 0;min-height:2px}',
    '.bar .lb{font-size:10px;color:#5d6573}',
    '.logrow{display:flex;gap:10px;padding:9px 0;border-bottom:1px solid #1b202a;font-size:12px;align-items:baseline}',
    '.logrow .tm{color:#5d6573;white-space:nowrap}',
    '.logrow .dm{color:#9fe1cb;white-space:nowrap}',
    '.logrow .rs{color:#b4bcc9;word-break:break-word}',
    '.empty{font-size:12px;color:#5d6573;padding:18px 0;text-align:center}',
    '.foot{padding:10px 20px;border-top:1px solid #212734;font-size:12px;color:#9fe1cb;min-height:38px}',
    '.x{padding:6px 10px}'
  ].join('');

  function panelShell() {
    return '<style>' + PANEL_CSS + '</style>' +
      '<div class="bg"><div class="card">' +
      '<div class="head"><div><div class="t">网站拦截器</div><div class="s">Alt + Shift + B 打开或关闭</div></div><div class="grow"></div><button class="x" data-act="close">关闭</button></div>' +
      '<div class="tabs">' +
      '<button class="tab" data-tab="list">名单</button>' +
      '<button class="tab" data-tab="opt">设置</button>' +
      '<button class="tab" data-tab="stat">统计</button>' +
      '<button class="tab" data-tab="log">日志</button>' +
      '</div>' +
      '<div class="body" id="body"></div>' +
      '<div class="foot" id="toast"></div>' +
      '</div></div>';
  }

  function ruleRow(r, i, isWhite) {
    var attrs = 'data-i="' + i + '"';
    var act = isWhite ? 'delw' : 'del';
    var hard = !isWhite && isStrictRule(r);
    var gname = isWhite ? '白名单' : (r.group || '自定义');
    var status;
    if (isWhite) {
      status = '<span class="st st-on">已启用</span>';
    } else if (hard) {
      status = '<span class="st st-lock">已锁定</span>';
    } else {
      status = '<button class="st ' + (r.enabled !== false ? 'st-on' : 'st-off') + '" data-act="toggle" ' + attrs + '>' +
        (r.enabled !== false ? '已启用' : '已停用') + '</button>';
    }
    var tagAttr = (!isWhite && !hard) ? ' data-act="gmove" ' + attrs + ' title="点击改分组"' : '';
    return '<div class="item' + (r.enabled === false && !isWhite ? ' off' : '') + '">' +
      '<span class="tag' + (hard ? ' hard' : '') + '"' + tagAttr + '>' + esc(gname) + '</span>' +
      '<span class="pat">' + esc(r.pattern) + '</span>' +
      status +
      '<button class="st st-del" data-act="' + act + '" ' + attrs + '>' + (hard ? '移出' : '删除') + '</button>' +
      '</div>';
  }

  function groupNames() {
    var seen = {};
    var out = [];
    cfg.rules.forEach(function (r) {
      var g = r.group || '自定义';
      if (!seen[g]) { seen[g] = true; out.push(g); }
    });
    return out;
  }

  function chipsHtml() {
    var counts = {};
    cfg.rules.forEach(function (r) {
      var g = r.group || '自定义';
      counts[g] = (counts[g] || 0) + 1;
    });
    var html = '<button class="chip' + (P.filterGroup ? '' : ' on') + '" data-act="gfilter" data-g="">全部 ' + cfg.rules.length + '</button>';
    groupNames().forEach(function (g) {
      html += '<button class="chip' + (P.filterGroup === g ? ' on' : '') + '" data-act="gfilter" data-g="' + esc(g) + '">' +
        esc(g) + ' ' + counts[g] + '</button>';
    });
    return html;
  }

  function groupsHtml() {
    var kw = String(P.filter || '').trim().toLowerCase();
    var buckets = {};
    var order = [];
    cfg.rules.forEach(function (r, i) {
      var g = r.group || '自定义';
      if (!buckets[g]) {
        buckets[g] = [];
        order.push(g);
      }
      buckets[g].push({ r: r, i: i });
    });

    var names = order.filter(function (g) {
      if (P.filterGroup && P.filterGroup !== g) return false;
      if (!kw) return true;
      return buckets[g].some(function (x) { return x.r.pattern.indexOf(kw) >= 0; });
    });

    names.sort(function (a, b) {
      var sa = groupMode(a) === 'strict' ? 0 : 1;
      var sb = groupMode(b) === 'strict' ? 0 : 1;
      return sa - sb;
    });

    if (!names.length) {
      return '<div class="empty">' + (cfg.rules.length ? '没有匹配的规则。' : '还没有规则，先加一个，或者到「设置」里导入预设包。') + '</div>';
    }

    var html = '';
    names.forEach(function (g) {
      var items = buckets[g].filter(function (x) { return !kw || x.r.pattern.indexOf(kw) >= 0; });
      if (!items.length) return;
      var meta = cfg.groupMeta[g] || { off: false, collapsed: false };
      var mode = groupMode(g);
      var modeTxt = mode === 'strict' ? '强制' : mode === 'window' ? '时段' : '全程';
      var collapsed = !!meta.collapsed && !kw;
      html += '<div class="grp">';
      html += '<div class="ghead">';
      html += '<button class="chev" data-act="gfold" data-g="' + esc(g) + '">' + (collapsed ? '▸' : '▾') + '</button>';
      html += '<span class="gname">' + esc(g) + '</span>';
      html += '<span class="gcount">' + items.length + '</span>';
      html += '<span class="mode m-' + mode + '">' + modeTxt + '</span>';
      if (meta.off && mode !== 'strict') html += '<span class="goff">已停用</span>';
      html += '<span style="flex:1"></span>';
      if (mode !== 'strict') {
        html += '<button class="mini" data-act="goff" data-g="' + esc(g) + '">' + (meta.off ? '启用整组' : '停用整组') + '</button>';
      }
      html += '</div>';
      if (!collapsed) {
        html += '<div class="items">';
        items.forEach(function (x) { html += ruleRow(x.r, x.i, false); });
        html += '</div>';
      }
      html += '</div>';
    });
    return html;
  }

  function tabList() {
    var host = String(location.hostname || '').toLowerCase();
    var base = baseDomain(host);
    var html = '';
    html += '<div class="sec"><div class="sec-h">快速添加</div><div class="row-add">';
    html += '<input id="inp" placeholder="bilibili.com 或 *.douyin.com 或 youtube.com/shorts 或 /regex/">';
    html += '<button class="pri" data-act="add">添加</button></div>';
    html += '<div class="hint">域名自动覆盖所有子域；含 / 的规则只拦该路径；/<code>正则</code>/ 用于高级匹配。新加的站会自动并入同域已有的分组，加完点左侧组名标签还能改组。</div>';
    if (base) html += '<div style="margin-top:10px"><button data-act="addcur">把当前站点 ' + esc(base) + ' 加入黑名单</button></div>';
    html += '</div>';

    html += '<div class="sec"><div class="sec-h">黑名单 <b>' + cfg.rules.length + '</b> 条</div>';
    html += '<div class="row-add" style="margin-top:8px"><input id="flt" placeholder="按域名筛选…" value="' + esc(P.filter) + '"></div>';
    html += '<div class="chips" id="gchips">' + chipsHtml() + '</div>';
    html += '<div id="glist">' + groupsHtml() + '</div>';
    html += '</div>';
    return html;
  }

  function field(label, control, note) {
    return '<div class="field"><label>' + label + '</label><div class="ctl">' + control + (note ? '<span class="note">' + note + '</span>' : '') + '</div></div>';
  }

  function daysText(days) {
    var d = Array.isArray(days) ? days.slice().sort(function (a, b) { return a - b; }) : [];
    if (!d.length || d.length === 7) return '每天';
    if (d.join(',') === '1,2,3,4,5') return '工作日';
    if (d.join(',') === '0,6') return '周末';
    var map = ['日', '一', '二', '三', '四', '五', '六'];
    return d.map(function (x) { return map[x]; }).join('');
  }

  function passText(p) {
    var bits = [];
    bits.push(p.passMinutes == null ? '放行沿用全局' : ('放行 ' + p.passMinutes + ' 分钟'));
    if (p.dailyPassLimit > 0) bits.push('每日 ' + p.dailyPassLimit + ' 次');
    return bits.join(' · ');
  }

  function modeSummary(g) {
    var m = groupMode(g);
    var p = policyOf(g);
    if (m === 'strict') return '强制 · 不可放行 · 忽略暂停';
    if (m === 'window') {
      return '时段 · ' + daysText(p.days) + ' ' + (p.windows.length ? p.windows.join(' / ') : '未设置时段') +
        ' · ' + (p.allowPassInWindow === false ? '不放行' : passText(p));
    }
    return '全程 · ' + passText(p);
  }

  function dayChips(days) {
    var map = ['日', '一', '二', '三', '四', '五', '六'];
    var on = Array.isArray(days) ? days : [1, 2, 3, 4, 5];
    var html = '';
    for (var i = 0; i < 7; i++) {
      html += '<button class="chip dchip' + (on.indexOf(i) >= 0 ? ' on' : '') + '" data-act="pday" data-d="' + i + '">' + map[i] + '</button>';
    }
    return html;
  }

  function winRow(w) {
    var parts = String(w || '09:00-12:00').split('-');
    var a = parts[0] || '09:00';
    var b = parts[1] || '12:00';
    return '<div class="wrow">' +
      '<input type="time" data-k="st" value="' + esc(a) + '">' +
      '<span class="dash">—</span>' +
      '<input type="time" data-k="et" value="' + esc(b) + '">' +
      '<button class="mini danger" data-act="wdel">删除</button>' +
      '</div>';
  }

  function policyEditor(g) {
    var p = policyOf(g);
    var mode = p.mode;
    var html = '<div class="pedit">';
    html += '<div class="plabel">拦截方式</div><div class="chips" id="pmode">';
    html += '<button class="chip' + (mode === 'always' ? ' on' : '') + '" data-act="pmode" data-m="always">全程</button>';
    html += '<button class="chip' + (mode === 'window' ? ' on' : '') + '" data-act="pmode" data-m="window">时段</button>';
    html += '<button class="chip' + (mode === 'strict' ? ' on' : '') + '" data-act="pmode" data-m="strict">强制</button>';
    html += '</div>';
    html += '<div class="hint" id="pstrict" style="display:' + (mode === 'strict' ? 'block' : 'none') + ';margin-top:8px">强制：拦截页没有放行入口，白名单、暂停都绕不过去；关闭强制要输入确认词。</div>';

    html += '<div id="pwin" style="display:' + (mode === 'window' ? 'block' : 'none') + '">';
    html += '<div class="plabel" style="margin-top:14px">拦截时段（这些时间之外正常访问）</div>';
    html += '<div id="wlist">';
    (p.windows.length ? p.windows : ['09:00-12:00']).forEach(function (w) { html += winRow(w); });
    html += '</div>';
    html += '<div style="margin-top:8px"><button class="mini" data-act="wadd">+ 添加时段</button></div>';
    html += '<div class="plabel" style="margin-top:14px">生效星期</div><div class="chips" id="pdays">' + dayChips(p.days) + '</div>';
    html += '<div class="pcheck" style="margin-top:12px"><label><input type="checkbox" id="pallow"' + (p.allowPassInWindow !== false ? ' checked' : '') + '> 时段内允许限时放行</label></div>';
    html += '</div>';

    html += '<div class="plabel" style="margin-top:14px">放行设置（留空沿用全局）</div>';
    html += '<div class="pgrid">';
    html += '<label class="pf">等待<input type="number" min="0" max="60" id="pwait" placeholder="' + cfg.waitSeconds + '" value="' + (p.waitSeconds == null ? '' : p.waitSeconds) + '"><i>秒</i></label>';
    html += '<label class="pf">单次<input type="number" min="1" max="120" id="ppass" placeholder="' + cfg.passMinutes + '" value="' + (p.passMinutes == null ? '' : p.passMinutes) + '"><i>分钟</i></label>';
    html += '<label class="pf">每日<input type="number" min="0" max="99" id="plimit" value="' + (p.dailyPassLimit || 0) + '"><i>次</i></label>';
    html += '</div>';
    html += '<div class="pcheck" style="margin-top:10px"><label>理由 <select id="preason"><option value="">沿用全局</option><option value="1"' + (p.requireReason === true ? ' selected' : '') + '>必须填</option><option value="0"' + (p.requireReason === false ? ' selected' : '') + '>不必填</option></select></label></div>';
    html += '<div class="chips" style="margin-top:14px"><button class="pri" data-act="psave" data-g="' + esc(g) + '">保存</button><button data-act="pcancel">取消</button></div>';
    html += '</div>';
    return html;
  }

  function policySection() {
    var groups = groupNames();
    var html = '<div class="sec"><div class="sec-h">分组规则</div>';
    if (!groups.length) {
      return html + '<div class="hint">还没有分组，先在名单里加几条规则。</div></div>';
    }
    groups.forEach(function (g) {
      html += '<div class="pcard">';
      html += '<div class="prow">';
      html += '<span class="pname">' + esc(g) + '</span>';
      html += '<span class="psum">' + esc(modeSummary(g)) + '</span>';
      html += '<button class="st" data-act="pedit" data-g="' + esc(g) + '">' + (P.editGroup === g ? '收起' : '编辑') + '</button>';
      html += '</div>';
      if (P.editGroup === g) html += policyEditor(g);
      html += '</div>';
    });
    html += '<div class="hint">时段之外正常访问，也不计拦截；任何分组都能设成强制，从强制切回来要输入确认词。</div>';
    html += '</div>';
    return html;
  }

  function tabOpt() {
    var paused = cfg.pauseUntil && Date.now() < cfg.pauseUntil;
    var html = '';
    html += '<div class="sec"><div class="sec-h">状态</div>';
    html += field('总开关', '<input type="checkbox" data-cfg="enabled"' + (cfg.enabled ? ' checked' : '') + '>', '关掉后完全失效，谨慎');
    html += field('临时暂停', '<button data-act="pause">' + (paused ? '恢复拦截' : '暂停 30 分钟') + '</button>', paused ? '剩余 ' + Math.ceil((cfg.pauseUntil - Date.now()) / 60000) + ' 分钟' : '用于正常查资料');
    html += '</div>';

    html += '<div class="sec"><div class="sec-h">放行规则（全局默认）</div>';
    html += field('等待秒数', '<input type="number" min="0" max="60" data-cfg="waitSeconds" value="' + cfg.waitSeconds + '">', '0 到 60');
    html += field('单次放行', '<input type="number" min="1" max="120" data-cfg="passMinutes" value="' + cfg.passMinutes + '">', '分钟');
    html += field('必须填理由', '<input type="checkbox" data-cfg="requireReason"' + (cfg.requireReason ? ' checked' : '') + '>', '防手滑');
    html += '</div>';

    html += policySection();

    html += '<div class="sec"><div class="sec-h">访问 PIN（留空则不设）</div>';
    html += '<div class="row-add"><input id="pin" type="password" inputmode="numeric" placeholder="4 到 8 位数字" value="">';
    html += '<button data-act="savepin">保存 PIN</button></div>';
    html += '<div class="hint">' + (cfg.pinHash ? '已设置。打开面板需要输入。' : '未设置。设置后打开面板、改规则都需要 PIN。') + '</div>';
    html += '</div>';

    html += '<div class="sec"><div class="sec-h">提醒语（一行一条，每次随机抽一条）</div>';
    html += '<textarea id="quotes" rows="5">' + esc(cfg.quotes.join('\n')) + '</textarea>';
    html += '<div style="margin-top:8px"><button data-act="savequotes">保存提醒语</button></div>';
    html += '</div>';

    html += '<div class="sec"><div class="sec-h">批量导入（只补充缺少的条目）</div>';
    html += '<div class="chips">';
    Object.keys(PRESETS).forEach(function (k) {
      html += '<button data-act="preset" data-k="' + esc(k) + '">导入' + esc(k) + '（' + PRESETS[k].length + '）</button>';
    });
    html += '</div>';
    html += '</div>';

    html += '<div class="sec"><div class="sec-h">白名单（优先放行，命中就不会被拦）</div><div class="row-add">';
    html += '<input id="inpw" placeholder="例如 bilibili.com/read">';
    html += '<button data-act="addw">添加</button></div>';
    if (cfg.whitelist.length) {
      html += '<div class="items" style="margin-top:10px">';
      cfg.whitelist.forEach(function (r, i) { html += ruleRow(r, i, true); });
      html += '</div>';
    }
    html += '</div>';

    html += '<div class="sec"><div class="sec-h">数据</div>';
    html += '<div class="chips"><button data-act="export">导出配置</button><button data-act="import">导入配置</button><button class="danger" data-act="clearstats">清空统计</button></div>';
    html += '<textarea id="data" rows="4" placeholder="导出后 JSON 会出现在这里；粘贴 JSON 后点导入" style="margin-top:10px"></textarea>';
    html += '</div>';
    return html;
  }

  function tabStat() {
    var days = [];
    var i;
    for (i = 6; i >= 0; i--) {
      var k = ymd(new Date(Date.now() - i * DAY));
      days.push({ k: k, n: stats.days[k] ? num(stats.days[k].blocks, 0) : 0 });
    }
    var max = 1;
    days.forEach(function (d) { if (d.n > max) max = d.n; });

    var html = '<div class="sec"><div class="grid4">';
    html += '<div class="kv"><i>今日拦截</i><b>' + (stats.days[ymd()] ? num(stats.days[ymd()].blocks, 0) : 0) + '</b></div>';
    html += '<div class="kv"><i>本周拦截</i><b>' + weekBlocks() + '</b></div>';
    html += '<div class="kv"><i>累计拦截</i><b>' + num(stats.total, 0) + '</b></div>';
    html += '<div class="kv"><i>连续守规</i><b>' + streakDays() + ' 天</b></div>';
    html += '</div></div>';

    html += '<div class="sec"><div class="sec-h">最近 7 天（估约省下 ' + fmtSaved(weekBlocks()) + '）</div><div class="bars">';
    days.forEach(function (d) {
      var h = Math.round((d.n / max) * 78);
      html += '<div class="bar"><div class="col" style="height:' + Math.max(2, h) + 'px"></div><div class="lb">' + d.k.slice(5).replace('-', '/') + '</div></div>';
    });
    html += '</div></div>';

    var map = {};
    Object.keys(stats.days).forEach(function (k) {
      var dd = stats.days[k];
      if (!dd || !dd.domains) return;
      Object.keys(dd.domains).forEach(function (h) {
        map[h] = num(map[h], 0) + num(dd.domains[h], 0);
      });
    });
    var top = Object.keys(map).sort(function (a, b) { return map[b] - map[a]; }).slice(0, 5);

    html += '<div class="sec"><div class="sec-h">最常想打开的站</div>';
    if (!top.length) {
      html += '<div class="empty">还没有数据。</div>';
    } else {
      html += '<div class="items">';
      top.forEach(function (h) {
        html += '<div class="sitrow"><span>' + esc(h) + '</span><span style="flex:1"></span><span style="color:#828b9a">' + map[h] + ' 次</span></div>';
      });
      html += '</div>';
    }
    html += '</div>';

    var gmap = {};
    Object.keys(map).forEach(function (h) {
      var g = hostGroup(h);
      gmap[g] = num(gmap[g], 0) + map[h];
    });
    var gnames = Object.keys(gmap).sort(function (a, b) { return gmap[b] - gmap[a]; });
    var gmax = 1;
    gnames.forEach(function (g) { if (gmap[g] > gmax) gmax = gmap[g]; });

    html += '<div class="sec"><div class="sec-h">按组统计（累计拦截次数）</div>';
    if (!gnames.length) {
      html += '<div class="empty">还没有数据。</div>';
    } else {
      gnames.forEach(function (g) {
        var pct = Math.max(2, Math.round((gmap[g] / gmax) * 100));
        html += '<div class="grow-row"><span class="nm">' + esc(g) + '</span>' +
          '<span class="track"><i style="width:' + pct + '%"></i></span>' +
          '<span class="vv">' + gmap[g] + '</span></div>';
      });
    }
    html += '</div>';

    html += '<div class="sec"><div class="hint">「省下」按每次拦截折算 ' + EST_MIN_PER_BLOCK + ' 分钟估算，仅作参考。按组统计用的是当前分组归属，改过分组后历史数据会跟着新分组走。</div></div>';
    return html;
  }

  function tabLog() {
    var html = '<div class="sec"><div class="sec-h">日志 <b>' + cfg.log.length + '</b> 条</div>';
    if (!cfg.log.length) {
      html += '<div class="empty">还没有放行记录。保持下去。</div>';
    } else {
      cfg.log.slice(0, 60).forEach(function (x) {
        html += '<div class="logrow"><span class="tm">' + fmtTime(x.ts) + '</span><span class="dm">' + esc(x.domain) + '</span><span class="rs">' + esc(x.reason) + '</span></div>';
      });
      html += '<div style="margin-top:14px"><button class="danger" data-act="clearlog">清空日志</button></div>';
    }
    html += '</div>';
    return html;
  }

  function toast(msg) {
    if (P.sr) {
      var el = P.sr.getElementById('toast');
      if (el) {
        el.textContent = msg;
        clearTimeout(el._t);
        el._t = setTimeout(function () { el.textContent = ''; }, 2400);
        return;
      }
    }
    try { alert(msg); } catch (e) { /* ignore */ }
  }

  function renderPanel() {
    closePanelDom();
    var host = document.createElement('div');
    host.setAttribute('data-apb', 'panel');
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;';
    var sr = host.attachShadow({ mode: 'closed' });
    sr.innerHTML = panelShell();
    document.documentElement.appendChild(host);
    P.root = host;
    P.sr = sr;
    P.open = true;

    sr.querySelectorAll('.tab').forEach(function (b) {
      b.addEventListener('click', function () {
        P.tab = b.getAttribute('data-tab');
        renderTab();
      });
    });
    var closeBtn = sr.querySelector('[data-act="close"]');
    if (closeBtn) closeBtn.addEventListener('click', closePanel);
    var bg = sr.querySelector('.bg');
    if (bg) {
      bg.addEventListener('mousedown', function (e) {
        if (e.target === bg) closePanel();
      });
    }
    renderTab();
  }

  function renderTab() {
    if (!P.sr) return;
    P.sr.querySelectorAll('.tab').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-tab') === P.tab);
    });
    var body = P.sr.getElementById('body');
    if (!body) return;
    if (P.tab === 'list') body.innerHTML = tabList();
    else if (P.tab === 'opt') body.innerHTML = tabOpt();
    else if (P.tab === 'stat') body.innerHTML = tabStat();
    else body.innerHTML = tabLog();

    bindActs(body);
    body.querySelectorAll('[data-cfg]').forEach(function (el) {
      el.addEventListener('change', function () { handleCfg(el); });
    });
    var flt = body.querySelector('#flt');
    if (flt) {
      flt.addEventListener('input', function () {
        P.filter = flt.value;
        var gl = P.sr.getElementById('glist');
        if (gl) {
          gl.innerHTML = groupsHtml();
          bindActs(gl);
        }
      });
    }
  }

  function bindActs(scope) {
    if (!scope) return;
    scope.querySelectorAll('[data-act]').forEach(function (el) {
      el.addEventListener('click', function (ev) {
        ev.preventDefault();
        handleAct(el.getAttribute('data-act'), el);
      });
    });
  }

  function handleCfg(el) {
    var k = el.getAttribute('data-cfg');
    if (k === 'enabled' || k === 'requireReason') {
      cfg[k] = !!el.checked;
    } else if (k === 'waitSeconds' || k === 'passMinutes') {
      cfg[k] = clamp(num(el.value, k === 'waitSeconds' ? 10 : 5), k === 'waitSeconds' ? 0 : 1, k === 'waitSeconds' ? 60 : 120);
      el.value = cfg[k];
    }
    saveCfg();
    toast('已保存');
  }

  function addRule(input, group, strict, inherit) {
    var n = normalizeRule(input);
    if (!n) return 0;
    var existing = null;
    cfg.rules.forEach(function (r) {
      if (r.type === n.type && r.pattern === n.pattern) existing = r;
    });
    if (existing) {
      if (strict && !existing.strict) {
        existing.strict = true;
        existing.enabled = true;
        existing.group = group || existing.group;
        addRule.lastGroup = existing.group || '';
        return 2;
      }
      return -1;
    }
    var g = group || '自定义';
    if (inherit && (!group || group === '自定义')) {
      var ig = inheritGroup(n);
      if (ig) g = ig;
    }
    cfg.rules.push({
      pattern: n.pattern,
      type: n.type,
      group: g,
      enabled: true,
      strict: !!strict
    });
    addRule.lastGroup = g;
    return 1;
  }

  function handleAct(act, el) {
    var i = Number(el.getAttribute('data-i'));
    if (act === 'add') {
      var inp = P.sr.getElementById('inp');
      var v = inp ? inp.value : '';
      var r = addRule(v, '自定义', false, true);
      if (r === 0) toast('规则无效，例如 bilibili.com');
      else if (r === -1) toast('这条已经在名单里了');
      else {
        saveCfg();
        toast('已加入「' + (addRule.lastGroup || '自定义') + '」分组');
        renderTab();
        var n = P.sr.getElementById('inp');
        if (n) n.focus();
      }
      return;
    }
    if (act === 'addcur') {
      var b = baseDomain(location.hostname);
      var rr = addRule(b, '自定义', false, true);
      if (rr === 1) {
        saveCfg();
        toast('已加入「' + (addRule.lastGroup || '自定义') + '」，刷新后生效');
        renderTab();
      } else {
        toast(rr === -1 ? '当前站点已在名单中' : '无法识别当前站点');
      }
      return;
    }
    if (act === 'del') {
      var target = cfg.rules[i];
      if (!target) return;
      if (isStrictRule(target)) {
        askConfirm(
          '永久移出「' + target.pattern + '」',
          '这条规则属于强制禁用分组。移出后该站点可以正常访问，且不会自动恢复。',
          '删除',
          function () {
            cfg.rules.splice(i, 1);
            saveCfg();
            toast('已永久移出：' + target.pattern);
            renderTab();
          }
        );
        return;
      }
      cfg.rules.splice(i, 1);
      saveCfg();
      toast('已删除');
      renderTab();
      return;
    }
    if (act === 'toggle') {
      if (cfg.rules[i]) {
        if (isStrictRule(cfg.rules[i])) {
          toast('强制禁用规则不能停用，只能永久移出');
          return;
        }
        cfg.rules[i].enabled = cfg.rules[i].enabled === false;
        saveCfg();
        renderTab();
      }
      return;
    }
    if (act === 'addw') {
      var iw = P.sr.getElementById('inpw');
      var vw = iw ? iw.value : '';
      var nw = normalizeRule(vw);
      if (!nw) { toast('规则无效'); return; }
      cfg.whitelist.push({ pattern: nw.pattern, type: nw.type, group: '白名单', enabled: true });
      saveCfg();
      toast('已加入白名单');
      renderTab();
      return;
    }
    if (act === 'delw') {
      cfg.whitelist.splice(i, 1);
      saveCfg();
      toast('已移除');
      renderTab();
      return;
    }
    if (act === 'gfold') {
      var g1 = el.getAttribute('data-g');
      var m1 = cfg.groupMeta[g1] || (cfg.groupMeta[g1] = { off: false, collapsed: false });
      m1.collapsed = !m1.collapsed;
      saveCfg();
      var gl = P.sr.getElementById('glist');
      if (gl) {
        gl.innerHTML = groupsHtml();
        bindActs(gl);
      }
      return;
    }
    if (act === 'goff') {
      var g2 = el.getAttribute('data-g');
      if (groupMode(g2) === 'strict') {
        toast('强制分组不能整组停用');
        return;
      }
      var m2 = cfg.groupMeta[g2] || (cfg.groupMeta[g2] = { off: false, collapsed: false });
      m2.off = !m2.off;
      saveCfg();
      renderTab();
      toast(m2.off ? ('已停用整组：' + g2) : ('已启用整组：' + g2));
      return;
    }
    if (act === 'gfilter') {
      var g3 = el.getAttribute('data-g') || '';
      P.filterGroup = (P.filterGroup === g3) ? '' : g3;
      renderTab();
      return;
    }
    if (act === 'gmove') {
      var rm = cfg.rules[i];
      if (!rm) return;
      if (isStrictRule(rm)) {
        toast('强制分组里的规则不能改组');
        return;
      }
      pickGroup('改分组', rm.pattern, rm.group || '自定义', function (g) {
        if (!cfg.rules[i]) return;
        cfg.rules[i].group = g;
        saveCfg();
        toast('已移到「' + g + '」' + (groupOff(g) ? '，该组当前已停用' : ''));
        renderTab();
      });
      return;
    }
    if (act === 'pedit') {
      var pg = el.getAttribute('data-g');
      P.editGroup = (P.editGroup === pg) ? null : pg;
      renderTab();
      return;
    }
    if (act === 'pcancel') {
      P.editGroup = null;
      renderTab();
      return;
    }
    if (act === 'pmode') {
      var pm = el.getAttribute('data-m');
      el.parentNode.querySelectorAll('.chip').forEach(function (b) {
        b.classList.toggle('on', b === el);
      });
      var pw = P.sr.getElementById('pwin');
      if (pw) pw.style.display = (pm === 'window') ? 'block' : 'none';
      var ps = P.sr.getElementById('pstrict');
      if (ps) ps.style.display = (pm === 'strict') ? 'block' : 'none';
      return;
    }
    if (act === 'pday') {
      el.classList.toggle('on');
      return;
    }
    if (act === 'wadd') {
      var wl = P.sr.getElementById('wlist');
      if (wl) {
        var tmp = document.createElement('div');
        tmp.innerHTML = winRow('09:00-12:00');
        var node = tmp.firstChild;
        if (node) {
          wl.appendChild(node);
          bindActs(node);
        }
      }
      return;
    }
    if (act === 'wdel') {
      var wr = el.closest('.wrow');
      if (wr) wr.remove();
      return;
    }
    if (act === 'psave') {
      var sg = el.getAttribute('data-g');
      var ed = el.closest('.pedit');
      if (!ed) return;
      var modeEl = ed.querySelector('#pmode .chip.on');
      var newMode = modeEl ? modeEl.getAttribute('data-m') : 'always';
      var wins = [];
      ed.querySelectorAll('#wlist .wrow').forEach(function (row) {
        var a = row.querySelector('[data-k="st"]').value;
        var b = row.querySelector('[data-k="et"]').value;
        if (a && b && a !== b) wins.push(a + '-' + b);
      });
      var daySel = [];
      ed.querySelectorAll('#pdays .chip.on').forEach(function (b) {
        daySel.push(Number(b.getAttribute('data-d')));
      });
      if (!daySel.length) daySel = [1, 2, 3, 4, 5];
      var waitV = (ed.querySelector('#pwait').value || '').trim();
      var passV = (ed.querySelector('#ppass').value || '').trim();
      var limV = (ed.querySelector('#plimit').value || '').trim();
      var reasonV = ed.querySelector('#preason').value;
      var allowEl = ed.querySelector('#pallow');
      var payload = {
        mode: newMode,
        windows: newMode === 'window' ? wins : [],
        days: daySel,
        allowPassInWindow: allowEl ? !!allowEl.checked : true,
        passMinutes: passV === '' ? null : clamp(num(passV, 5), 1, 120),
        waitSeconds: waitV === '' ? null : clamp(num(waitV, 10), 0, 60),
        requireReason: reasonV === '' ? null : reasonV === '1',
        dailyPassLimit: limV === '' ? 0 : clamp(num(limV, 0), 0, 99)
      };
      var commit = function () {
        cfg.groupPolicy[sg] = payload;
        saveCfg();
        P.editGroup = null;
        renderTab();
        toast('分组规则已保存');
      };
      if (groupMode(sg) === 'strict' && newMode !== 'strict') {
        askConfirm(
          '关闭「' + sg + '」的强制模式',
          '关闭后这个分组会恢复放行入口，规则也不再受强制保护。想清楚再动手。',
          '删除',
          commit
        );
        return;
      }
      commit();
      return;
    }
    if (act === 'preset') {
      var key = el.getAttribute('data-k');
      var list = PRESETS[key] || [];
      var added = 0;
      var up = 0;
      list.forEach(function (p) {
        var rc = addRule(p, key);
        if (rc === 1) added++;
        else if (rc === 2) up++;
      });
      saveCfg();
      toast((added || up)
        ? ('已导入 ' + added + ' 条' + (up ? '，升级为强制 ' + up + ' 条' : ''))
        : '这些条目都已经在名单里');
      renderTab();
      return;
    }
    if (act === 'pause') {
      var paused = cfg.pauseUntil && Date.now() < cfg.pauseUntil;
      cfg.pauseUntil = paused ? 0 : Date.now() + 30 * 60000;
      saveCfg();
      toast(paused ? '已恢复拦截' : '已暂停 30 分钟');
      renderTab();
      return;
    }
    if (act === 'savepin') {
      var pinEl = P.sr.getElementById('pin');
      var pv = pinEl ? pinEl.value.trim() : '';
      if (pv && !/^\d{4,8}$/.test(pv)) { toast('PIN 需要 4 到 8 位数字'); return; }
      cfg.pinHash = pv ? hashPin(pv) : '';
      saveCfg();
      toast(pv ? 'PIN 已设置' : 'PIN 已清除');
      renderTab();
      return;
    }
    if (act === 'savequotes') {
      var qEl = P.sr.getElementById('quotes');
      var lines = (qEl ? qEl.value : '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
      cfg.quotes = lines.length ? lines : DEFAULT_QUOTES.slice();
      saveCfg();
      toast('提醒语已保存');
      renderTab();
      return;
    }
    if (act === 'export') {
      var d = P.sr.getElementById('data');
      if (d) {
        d.value = JSON.stringify({
          rules: cfg.rules,
          whitelist: cfg.whitelist,
          groupMeta: cfg.groupMeta,
          groupPolicy: cfg.groupPolicy,
          quotes: cfg.quotes,
          waitSeconds: cfg.waitSeconds,
          passMinutes: cfg.passMinutes
        }, null, 2);
        d.select();
      }
      toast('已生成 JSON，可直接复制');
      return;
    }
    if (act === 'import') {
      var d2 = P.sr.getElementById('data');
      try {
        var obj = JSON.parse(d2 ? d2.value : '');
        if (obj.rules) cfg.rules = obj.rules.map(fixRule).filter(Boolean);
        if (obj.whitelist) cfg.whitelist = obj.whitelist.map(fixRule).filter(Boolean);
        if (obj.groupMeta && typeof obj.groupMeta === 'object') cfg.groupMeta = obj.groupMeta;
        if (obj.groupPolicy && typeof obj.groupPolicy === 'object') cfg.groupPolicy = obj.groupPolicy;
        if (obj.quotes && obj.quotes.length) cfg.quotes = obj.quotes;
        if (obj.waitSeconds != null) cfg.waitSeconds = clamp(num(obj.waitSeconds, 10), 0, 60);
        if (obj.passMinutes != null) cfg.passMinutes = clamp(num(obj.passMinutes, 5), 1, 120);
        saveCfg();
        toast('导入成功');
        renderTab();
      } catch (e) {
        toast('JSON 解析失败，检查一下格式');
      }
      return;
    }
    if (act === 'clearstats') {
      if (!confirm('清空全部拦截统计？')) return;
      stats = { total: 0, days: {} };
      saveStats();
      toast('统计已清空');
      renderTab();
      return;
    }
    if (act === 'clearlog') {
      if (!confirm('清空日志？')) return;
      cfg.log = [];
      saveCfg();
      toast('日志已清空');
      renderTab();
      return;
    }
  }

  function hashPin(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) {
      h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    }
    return 'h' + h.toString(36);
  }

  function closePanelDom() {
    if (P.root && P.root.isConnected) P.root.remove();
    P.root = null;
    P.sr = null;
    P.open = false;
  }

  function closePanel() {
    closePanelDom();
  }

  function pickGroup(title, sub, current, cb) {
    var host = document.createElement('div');
    host.setAttribute('data-apb', 'pick');
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;';
    var sr = host.attachShadow({ mode: 'closed' });

    var names = groupNames();
    if (names.indexOf('自定义') < 0) names.push('自定义');
    var picked = current || '自定义';

    var chips = '';
    names.forEach(function (g) {
      chips += '<button class="chip' + (g === picked ? ' on' : '') + '" data-pick="' + esc(g) + '">' + esc(g) + '</button>';
    });

    sr.innerHTML = '<style>' + PANEL_CSS + '</style>' +
      '<div class="bg"><div class="card" style="max-width:430px;padding:22px">' +
      '<div style="font-size:15px;font-weight:500">' + esc(title) + '</div>' +
      '<div style="font-size:12px;color:#828b9a;margin-top:6px;word-break:break-all">' + esc(sub) + '</div>' +
      '<div class="chips" id="cs" style="margin-top:14px">' + chips + '</div>' +
      '<input id="ng" placeholder="或输入新分组名" autocomplete="off" style="margin-top:12px">' +
      '<div class="chips" style="margin-top:14px"><button class="pri" id="ok">确定</button><button id="no">取消</button></div>' +
      '</div></div>';

    document.documentElement.appendChild(host);
    var ng = sr.getElementById('ng');

    function choose(g) {
      picked = g;
      if (ng) ng.value = '';
      sr.querySelectorAll('[data-pick]').forEach(function (b) {
        b.classList.toggle('on', b.getAttribute('data-pick') === g);
      });
    }

    function done(ok) {
      var final = '';
      if (ok) {
        final = ((ng && ng.value.trim()) || picked || '').trim();
        if (!final) return;
      }
      if (host.isConnected) host.remove();
      if (ok) cb(final);
    }

    sr.querySelectorAll('[data-pick]').forEach(function (b) {
      b.addEventListener('click', function (ev) {
        ev.preventDefault();
        choose(b.getAttribute('data-pick'));
      });
    });
    if (ng) {
      ng.addEventListener('input', function () {
        if (ng.value.trim()) {
          sr.querySelectorAll('[data-pick]').forEach(function (b) { b.classList.remove('on'); });
        }
      });
      ng.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          done(true);
        }
      });
    }
    sr.getElementById('ok').addEventListener('click', function () { done(true); });
    sr.getElementById('no').addEventListener('click', function () { done(false); });
  }

  function askConfirm(title, desc, word, cb) {
    var host = document.createElement('div');
    host.setAttribute('data-apb', 'confirm');
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;';
    var sr = host.attachShadow({ mode: 'closed' });
    sr.innerHTML = '<style>' + PANEL_CSS + '</style>' +
      '<div class="bg"><div class="card" style="max-width:380px;padding:22px">' +
      '<div style="font-size:15px;font-weight:500;margin-bottom:8px">' + esc(title) + '</div>' +
      '<div style="font-size:12px;color:#828b9a;line-height:1.7">' + desc + '</div>' +
      '<input id="w" placeholder="输入「' + esc(word) + '」确认" style="margin-top:14px" autocomplete="off">' +
      '<div id="err" style="font-size:12px;color:#f09595;height:16px;margin-top:6px"></div>' +
      '<div class="chips"><button class="pri" id="ok">确认</button><button id="no">取消</button></div>' +
      '</div></div>';
    document.documentElement.appendChild(host);
    var inp = sr.getElementById('w');
    var err = sr.getElementById('err');
    if (inp) inp.focus();

    function close(ok) {
      if (host.isConnected) host.remove();
      if (ok) cb();
    }
    function check() {
      var v = inp ? inp.value.trim() : '';
      if (v === word) close(true);
      else if (err) err.textContent = '要输入「' + word + '」才能继续';
    }
    sr.getElementById('ok').addEventListener('click', check);
    sr.getElementById('no').addEventListener('click', function () { close(false); });
    if (inp) {
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') check();
      });
    }
  }

  function askPin(cb) {
    var host = document.createElement('div');
    host.setAttribute('data-apb', 'pin');
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;';
    var sr = host.attachShadow({ mode: 'closed' });
    sr.innerHTML = '<style>' + PANEL_CSS + '</style>' +
      '<div class="bg"><div class="card" style="max-width:340px;padding:22px">' +
      '<div class="t" style="font-size:15px;font-weight:500;margin-bottom:6px">输入 PIN</div>' +
      '<div class="s" style="font-size:12px;color:#6f7887;margin-bottom:14px">改动规则需要验证</div>' +
      '<input id="p" type="password" inputmode="numeric" placeholder="4 到 8 位数字" autocomplete="off">' +
      '<div id="err" style="font-size:12px;color:#f09595;height:18px;margin-top:6px"></div>' +
      '<div class="chips" style="margin-top:8px"><button class="pri" id="ok">确定</button><button id="no">取消</button></div>' +
      '</div></div>';
    document.documentElement.appendChild(host);
    var inp = sr.getElementById('p');
    var err = sr.getElementById('err');
    if (inp) inp.focus();

    function done(ok) {
      if (host.isConnected) host.remove();
      if (ok) cb();
    }
    sr.getElementById('ok').addEventListener('click', function () {
      var v = inp ? inp.value.trim() : '';
      if (hashPin(v) === cfg.pinHash) done(true);
      else if (err) err.textContent = 'PIN 不对';
    });
    sr.getElementById('no').addEventListener('click', function () { done(false); });
    if (inp) {
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          if (hashPin(inp.value.trim()) === cfg.pinHash) done(true);
          else if (err) err.textContent = 'PIN 不对';
        }
      });
    }
  }

  function openPanel() {
    if (P.open) { closePanel(); return; }
    cfg = loadCfg();
    stats = loadStats();
    P.filter = '';
    P.filterGroup = '';
    P.editGroup = null;
    if (cfg.pinHash) askPin(function () { renderPanel(); });
    else renderPanel();
  }

  function registerMenus() {
    try {
      var base = baseDomain(location.hostname);
      GM_registerMenuCommand('拦截当前网站（' + base + '）', function () {
        cfg = loadCfg();
        var nn = normalizeRule(base);
        if (!nn) {
          toast('无法识别当前站点');
          return;
        }
        var exist = null;
        cfg.rules.forEach(function (r) {
          if (r.type === nn.type && r.pattern === nn.pattern) exist = r;
        });
        if (exist && isStrictRule(exist)) {
          toast('这条在强制分组里，不能改分组');
          return;
        }
        var init = exist ? (exist.group || '自定义') : (inheritGroup(nn) || '自定义');
        pickGroup(exist ? '修改分组' : '加入黑名单', base, init, function (g) {
          cfg = loadCfg();
          var cur = null;
          cfg.rules.forEach(function (r) {
            if (r.type === nn.type && r.pattern === nn.pattern) cur = r;
          });
          if (cur) {
            if (isStrictRule(cur)) {
              toast('强制分组的规则不能改分组');
              return;
            }
            cur.group = g;
          } else {
            addRule(base, g, false, false);
          }
          saveCfg();
          var hit = findHit();
          if (hit) {
            blockNow(hit);
          } else {
            toast((cur ? '已移到「' : '已加入「') + g + '」' + (groupOff(g) ? '，该组当前已停用' : ''));
          }
        });
      });
      GM_registerMenuCommand('把当前网站移出黑名单（' + base + '）', function () {
        cfg = loadCfg();
        var ctx = {
          host: String(location.hostname || '').toLowerCase(),
          path: location.pathname + location.search,
          href: location.href
        };
        var before = cfg.rules.length;
        var hardLocked = false;
        cfg.rules = cfg.rules.filter(function (r) {
          if (isStrictRule(r)) {
            if (matchPattern({ pattern: r.pattern, type: r.type, enabled: true }, ctx)) hardLocked = true;
            return true;
          }
          return !matchPattern({ pattern: r.pattern, type: r.type, enabled: true }, ctx);
        });
        if (cfg.rules.length < before) {
          saveCfg();
          toast('已移出黑名单，刷新后生效');
        } else if (hardLocked) {
          toast('这条属于强制禁用，只能在面板里永久移出');
        } else {
          toast('当前网站不在黑名单里');
        }
      });
      GM_registerMenuCommand('打开设置面板', function () {
        openPanel();
      });
      GM_registerMenuCommand('暂停 30 分钟 / 恢复拦截', function () {
        cfg = loadCfg();
        var paused = cfg.pauseUntil && Date.now() < cfg.pauseUntil;
        cfg.pauseUntil = paused ? 0 : Date.now() + 30 * 60000;
        saveCfg();
        toast(paused ? '已恢复拦截' : '已暂停 30 分钟');
      });
    } catch (e) { /* ignore */ }
  }

  function boot() {
    cfg = loadCfg();
    stats = loadStats();
    if (!isTopFrame()) return;
    if (!/^https?:$/i.test(location.protocol)) return;

    installHotkey();
    registerMenus();

    if (!cfg.enabled) { installSpaGuard(); return; }
    if (cfg.pauseUntil && Date.now() < cfg.pauseUntil) {
      var sh = findStrictHit();
      if (sh) blockNow(sh);
      else installSpaGuard();
      return;
    }

    var exp = getPass(location.hostname);
    var hit = findHit();
    if (!hit) { installSpaGuard(); return; }
    if (!isStrictRule(hit) && exp > Date.now()) { showPassBadge(exp); installSpaGuard(); return; }
    blockNow(hit);
  }

  boot();
})();
