/* Triage UI controller. All scoring happens in TriageEngine (engine.js). */
(function () {
  'use strict';
  const E = window.TriageEngine;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const PAGE = 100;
  const STORAGE_KEY = 'triage:thesis:v1';
  const SAMPLE_NAME = 'sample_saasquatch_export.csv';

  const state = {
    rowCount: 0,
    leads: [],
    scored: [],
    summary: null,
    thesis: loadThesis(),
    domainInfo: {},
    view: 'contact',
    query: '',
    shown: PAGE,
    selected: null,
    api: { online: false, base: '', mode: null },
    pending: null, // parsed CSV awaiting mapping confirmation
    listName: '',
    isSample: false,
  };

  // ------------------------------------------------------------ persistence

  function loadThesis() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const t = JSON.parse(raw);
        if (t && t.mode && E.PRESETS[t.mode] && t.weights) return t;
      }
    } catch (e) { /* storage unavailable */ }
    return E.clonePreset('acquisition');
  }

  function saveThesis() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.thesis)); } catch (e) { /* ignore */ }
  }

  // --------------------------------------------------------------------- API

  function apiBase() {
    if (typeof window.TRIAGE_API_BASE === 'string') return window.TRIAGE_API_BASE.replace(/\/$/, '');
    return '';
  }

  async function apiFetch(path, opts, timeoutMs) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs || 15000);
    try {
      const res = await fetch(state.api.base + path, Object.assign({ signal: ctrl.signal, headers: { 'Content-Type': 'application/json' } }, opts));
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
      return res.status === 204 ? null : res.json();
    } finally { clearTimeout(t); }
  }

  async function checkApi() {
    state.api.base = apiBase();
    const pill = $('apiStatus');
    if (location.protocol === 'file:' && !state.api.base) return setOffline();
    try {
      const h = await apiFetch('/api/health', { method: 'GET' }, 2500);
      state.api.online = true;
      state.api.mode = h.dns_mode;
      pill.dataset.state = 'online';
      pill.textContent = h.dns_mode === 'mx' ? 'Mail-server checks on' : 'Domain checks on';
      pill.title = 'Connected to the Triage API. Domains are checked for DNS and MX records and cached for ' + Math.round(h.cache_ttl_days) + ' days.';
      $('listMenuWrap').hidden = false;
    } catch (e) { setOffline(); }

    function setOffline() {
      state.api.online = false;
      pill.dataset.state = 'offline';
      pill.textContent = 'Offline mode';
      pill.title = 'Running fully in the browser. Connect the Triage API to verify that email domains can receive mail.';
    }
  }

  async function runDomainChecks() {
    if (!state.api.online || !state.leads.length) return;
    if (state.isSample) {
      toast('Sample data uses invented domains, so mail-server checks are skipped. Import a real export to see them.');
      return;
    }
    const domains = E.domainsToCheck(state.leads).filter((d) => !(d in state.domainInfo));
    if (!domains.length) return;
    const pill = $('apiStatus');
    pill.dataset.state = 'busy';
    let done = 0;
    let cacheHits = 0;
    try {
      for (let i = 0; i < domains.length; i += 200) {
        const batch = domains.slice(i, i + 200);
        pill.textContent = `Checking domains ${done}/${domains.length}`;
        const r = await apiFetch('/api/domains/check', { method: 'POST', body: JSON.stringify({ domains: batch }) }, 30000);
        Object.assign(state.domainInfo, r.results);
        done += batch.length;
        cacheHits += r.stats.cache_hits;
        rescore();
      }
      const dead = Object.values(state.domainInfo).filter((d) => d.has_mx === false).length;
      toast(`Checked ${done} domains (${cacheHits} from cache). ${dead} cannot receive email.`);
    } catch (e) {
      toast('Domain checks stopped: ' + e.message);
    } finally {
      pill.dataset.state = 'online';
      pill.textContent = state.api.mode === 'mx' ? 'Mail-server checks on' : 'Domain checks on';
    }
  }

  // ------------------------------------------------------------------ import

  function readFile(file) {
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) return toast('That file is over 25 MB. Split it and import the parts.');
    const reader = new FileReader();
    reader.onload = () => beginImport(String(reader.result), file.name);
    reader.onerror = () => toast('Could not read that file. Export it again as CSV and retry.');
    reader.readAsText(file);
  }

  function beginImport(text, name) {
    const parsed = E.parseCSV(text);
    if (!parsed.headers.length || !parsed.records.length) return toast('No rows found. Check that the file is a CSV with a header row.');
    state.pending = { parsed, name, mapping: E.detectColumns(parsed.headers), isSample: name === SAMPLE_NAME };
    if (!state.pending.mapping.company && !state.pending.mapping.website) {
      toast('Could not find a company or website column. Pick them below.');
    }
    openMapping();
  }

  function openMapping() {
    const { parsed, mapping, name } = state.pending;
    const found = Object.keys(mapping).length;
    $('mapSummary').textContent = `${parsed.records.length.toLocaleString()} rows in ${name}. Matched ${found} of ${parsed.headers.length} columns. Fix anything that looks wrong.`;
    const sample = parsed.records.find((r) => Object.values(r).filter(Boolean).length > 4) || parsed.records[0];
    const opts = ['<option value="">Not in this file</option>'].concat(parsed.headers.map((h) => `<option value="${esc(h)}">${esc(h)}</option>`)).join('');
    const important = ['company', 'website', 'industry', 'revenue', 'employees', 'founded', 'contactName', 'title', 'email', 'phone', 'city', 'state'];
    const rest = Object.keys(E.FIELDS).filter((f) => !important.includes(f));
    $('mapFields').innerHTML = important.concat(rest).map((f) => {
      const h = mapping[f] || '';
      return `<label>${esc(E.FIELDS[f].label)}
        <select data-field="${f}">${opts}</select>
        <span class="example" data-example="${f}">${h && sample[h] ? 'e.g. ' + esc(sample[h]) : '&nbsp;'}</span></label>`;
    }).join('');
    $('mapFields').querySelectorAll('select').forEach((sel) => {
      sel.value = mapping[sel.dataset.field] || '';
      sel.addEventListener('change', () => {
        const ex = $('mapFields').querySelector(`[data-example="${sel.dataset.field}"]`);
        ex.innerHTML = sel.value && sample[sel.value] ? 'e.g. ' + esc(sample[sel.value]) : '&nbsp;';
      });
    });
    $('mapDialog').showModal();
  }

  function confirmMapping() {
    const mapping = {};
    $('mapFields').querySelectorAll('select').forEach((sel) => { if (sel.value) mapping[sel.dataset.field] = sel.value; });
    if (!mapping.company && !mapping.website) {
      toast('Pick at least a company name or website column.');
      return false;
    }
    const { parsed, name, isSample } = state.pending;
    const t0 = performance.now();
    state.isSample = !!isSample;
    const normalized = parsed.records.map((r) => E.normalize(r, mapping));
    state.leads = E.dedupe(normalized);
    state.rowCount = parsed.records.length;
    state.domainInfo = {};
    state.listName = name.replace(/\.[a-z]+$/i, '');
    state.pending = null;
    state.view = 'contact';
    state.shown = PAGE;
    rescore();
    $('empty').hidden = true;
    $('board').hidden = false;
    $('funnel').hidden = false;
    $('saveListBtn').disabled = false;
    $('exportMenu').querySelector('summary').removeAttribute('aria-disabled');
    const ms = Math.round(performance.now() - t0);
    toast(`Scored ${state.leads.length.toLocaleString()} companies in ${ms} ms.`);
    $('main').focus();
    runDomainChecks();
    return true;
  }

  // ------------------------------------------------------------------ scoring

  let raf = 0;
  function scheduleRescore() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(rescore);
  }

  function rescore() {
    if (!state.leads.length) return;
    state.scored = E.scoreLeads(state.leads, state.thesis, state.domainInfo);
    state.summary = E.summarize(state.rowCount, state.scored);
    renderFunnel();
    renderTabs();
    renderRows();
    if (state.selected) {
      const lead = state.scored.find((l) => l.id === state.selected);
      if (lead) renderDrawer(lead);
    }
  }

  // ------------------------------------------------------------------- thesis

  function renderThesis() {
    const t = state.thesis;
    document.querySelectorAll('.segmented [data-mode]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === t.mode)));
    $('modeHelp').textContent = t.mode === 'acquisition'
      ? 'Favors owner-run businesses with long operating histories and repeat revenue.'
      : 'Favors companies big enough to buy, with a reachable decision maker.';
    $('revMin').value = +(t.revenue.min / 1e6).toFixed(2);
    $('revMax').value = +(t.revenue.max / 1e6).toFixed(2);
    $('empMin').value = t.employees.min;
    $('empMax').value = t.employees.max;
    $('minYears').value = t.minYears;
    $('industryList').innerHTML = E.INDUSTRY_GROUP_NAMES.concat(['Other']).map((g) =>
      `<label><input type="checkbox" value="${esc(g)}" ${t.industries.includes(g) ? 'checked' : ''}> ${esc(g)}</label>`).join('');
    renderWeights();
    $('template').value = t.template;
  }

  function renderWeights() {
    const t = state.thesis;
    const total = Object.values(t.weights).reduce((a, b) => a + b, 0) || 1;
    $('weights').innerHTML = Object.entries(E.FACTORS).map(([k, f]) =>
      `<div class="weight">
        <span class="swatch" style="background:var(--${f.color})"></span>
        <label for="w-${k}">${esc(f.label)}</label>
        <output for="w-${k}" id="o-${k}">${Math.round((t.weights[k] / total) * 100)}%</output>
        <input id="w-${k}" type="range" min="0" max="40" step="1" value="${t.weights[k]}" data-weight="${k}">
      </div>`).join('');
  }

  function updateWeightOutputs() {
    const t = state.thesis;
    const total = Object.values(t.weights).reduce((a, b) => a + b, 0) || 1;
    for (const k of Object.keys(E.FACTORS)) $('o-' + k).textContent = Math.round((t.weights[k] / total) * 100) + '%';
  }

  function bindThesis() {
    document.querySelectorAll('.segmented [data-mode]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.mode === state.thesis.mode) return;
      state.thesis = E.clonePreset(b.dataset.mode);
      onThesisChange(true);
    }));
    $('resetThesis').addEventListener('click', () => { state.thesis = E.clonePreset(state.thesis.mode); onThesisChange(true); toast('Thesis reset to the ' + state.thesis.label.toLowerCase() + ' defaults.'); });
    const num = (id, fn) => $(id).addEventListener('input', () => { const v = parseFloat($(id).value); if (!isNaN(v) && v >= 0) { fn(v); onThesisChange(); } });
    num('revMin', (v) => { state.thesis.revenue.min = v * 1e6; });
    num('revMax', (v) => { state.thesis.revenue.max = v * 1e6; });
    num('empMin', (v) => { state.thesis.employees.min = v; });
    num('empMax', (v) => { state.thesis.employees.max = v; });
    num('minYears', (v) => { state.thesis.minYears = v; });
    $('industryList').addEventListener('change', () => {
      state.thesis.industries = Array.from($('industryList').querySelectorAll('input:checked')).map((i) => i.value);
      onThesisChange();
    });
    $('weights').addEventListener('input', (e) => {
      const k = e.target.dataset.weight;
      if (!k) return;
      state.thesis.weights[k] = parseInt(e.target.value, 10);
      updateWeightOutputs();
      onThesisChange();
    });
    $('template').addEventListener('input', () => { state.thesis.template = $('template').value; saveThesis(); if (state.selected) updateOpener(); });
  }

  function onThesisChange(full) {
    if (full) renderThesis();
    saveThesis();
    scheduleRescore();
  }

  // ------------------------------------------------------------------- funnel

  function renderFunnel() {
    const s = state.summary;
    const pct = (n) => (s.rows ? Math.max(2, (n / s.rows) * 100) : 0) + '%';
    const stage = (n, label, sub) => `<div class="stage"><div class="stage-n">${n.toLocaleString()}</div><div class="stage-label">${label}</div>${sub ? `<div class="stage-sub">${sub}</div>` : ''}<div class="sieve"><i style="width:${pct(n)}"></i></div></div>`;
    const credits = s.creditsSaved > 0
      ? `Uses ${s.queues.enrich} credits, not ${s.creditsIfEnrichAll}`
      : `${s.queues.enrich} credits`;
    $('funnel').innerHTML =
      stage(s.rows, 'Rows imported', s.rows - s.unique > 0 ? `${(s.rows - s.unique).toLocaleString()} duplicate or blank rows` : '') +
      stage(s.unique, 'Unique companies', s.invalidEmails ? `${s.invalidEmails} bad emails flagged` : '') +
      stage(s.reachable, 'Reach a person today', 'Without spending a credit') +
      stage(s.strongFit, 'Strong or good fit', `${s.tiers.A} in tier A, ${s.tiers.B} in tier B`) +
      `<div class="outcome">
        <button type="button" class="outcome-card contact" data-view="contact"><div class="stage-n">${s.queues.contact}</div><div class="stage-label">Contact now</div><div class="stage-sub">Fit and reachable</div></button>
        <button type="button" class="outcome-card enrich" data-view="enrich"><div class="stage-n">${s.queues.enrich}</div><div class="stage-label">Worth enriching</div><div class="stage-sub">${credits}</div></button>
      </div>`;
  }

  // -------------------------------------------------------------------- table

  const TABS = [
    ['contact', 'Contact now'],
    ['enrich', 'Enrich first'],
    ['hold', 'Hold'],
    ['skip', 'Skip'],
    ['all', 'All'],
  ];

  function renderTabs() {
    const q = state.summary.queues;
    const counts = Object.assign({ all: state.summary.unique }, q);
    $('tabs').innerHTML = TABS.map(([id, label]) =>
      `<button class="tab" role="tab" type="button" data-view="${id}" aria-selected="${state.view === id}">${label}<span class="count">${counts[id]}</span></button>`).join('');
  }

  function visibleLeads() {
    const q = state.query.trim().toLowerCase();
    return state.scored.filter((l) => (state.view === 'all' || l.queue === state.view) &&
      (!q || [l.company, l.city, l.state, l.contactName, l.domain, l.industry].some((v) => v && String(v).toLowerCase().includes(q))));
  }

  function emailDot(l) {
    const e = l.emailEffective;
    if (e.status === 'missing') return 'dot-none';
    if (e.status === 'invalid') return 'dot-bad';
    return e.type === 'role' ? 'dot-warn' : 'dot-ok';
  }

  function renderRows() {
    const list = visibleLeads();
    const rows = list.slice(0, state.shown);
    if (!rows.length) {
      const msg = state.query ? 'No leads match that search.' : {
        contact: 'No reachable strong-fit leads yet. Check the Enrich first tab, or widen your thesis.',
        enrich: 'Nothing needs enriching. Every strong-fit lead already has a way to reach the owner.',
        hold: 'No weak-fit leads.', skip: 'Nothing to skip.', all: 'No leads.',
      }[state.view];
      $('rows').innerHTML = `<tr class="no-rows"><td colspan="6">${msg}</td></tr>`;
    } else {
      $('rows').innerHTML = rows.map((l) => {
        const sig = [l.industryGroup || l.industry, l.revenue ? E.rangeLabel(l.revenue, E.money) : '', l.employees ? E.rangeLabel(l.employees, E.count) + ' staff' : '', l.years != null ? l.years + ' yrs' : '']
          .filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join('');
        const contact = l.contactName
          ? `<div class="contact-line"><span class="dot ${emailDot(l)}" title="${esc(l.emailEffective.label)}"></span>${esc(l.contactName)}</div><div class="sub">${esc(l.title || E.SENIORITY_LABEL[l.seniority])}</div>`
          : `<div class="contact-line"><span class="dot ${emailDot(l)}" title="${esc(l.emailEffective.label)}"></span><span class="sub">No named contact</span></div>`;
        return `<tr data-id="${l.id}" tabindex="0" ${state.selected === l.id ? 'aria-current="true"' : ''}>
          <td class="num">${l.rank}</td>
          <td><div class="score"><span class="tier tier-${l.tier}" title="${esc(E.TIERS.find((t) => t.id === l.tier).label)}">${l.tier}</span><b>${l.score}</b></div></td>
          <td><div class="co-name">${esc(l.company || l.domain)}</div><div class="sub meta">${l.domain ? `<span>${esc(l.domain)}</span>` : ''}${l.city || l.state ? `<span>${esc([l.city, l.state].filter(Boolean).join(', '))}</span>` : ''}</div></td>
          <td><div class="signals">${sig || '<span class="sub">Not enough data</span>'}</div></td>
          <td>${contact}</td>
          <td><span class="queue queue-${l.queue}">${E.QUEUE_LABEL[l.queue]}</span></td>
        </tr>`;
      }).join('');
    }
    $('shownCount').textContent = list.length ? `Showing ${Math.min(state.shown, list.length)} of ${list.length}` : '';
    $('moreBtn').hidden = list.length <= state.shown;
  }

  // ------------------------------------------------------------------- drawer

  function openDrawer(id) {
    const lead = state.scored.find((l) => l.id === id);
    if (!lead) return;
    state.selected = id;
    renderDrawer(lead);
    $('drawer').hidden = false;
    $('scrim').hidden = false;
    renderRows();
    $('drawer').querySelector('.close').focus();
  }

  function closeDrawer() {
    const id = state.selected;
    state.selected = null;
    $('drawer').hidden = true;
    $('scrim').hidden = true;
    renderRows();
    const row = document.querySelector(`tr[data-id="${id}"]`);
    if (row) row.focus();
  }

  function renderDrawer(l) {
    const tier = E.TIERS.find((t) => t.id === l.tier);
    const anatomy = l.breakdown.map((f) => `<i style="width:${f.points}%;background:var(--${f.color})" title="${esc(f.label)}: ${f.points.toFixed(1)}"></i>`).join('');
    const factors = l.breakdown.filter((f) => f.max > 0).map((f) =>
      `<li class="factor"><span class="swatch" style="background:var(--${f.color})"></span><span>${esc(f.label)}</span><span class="pts">${Math.round(f.points)} / ${Math.round(f.max)}</span><span class="note">${esc(f.note)}</span></li>`).join('');
    const why = l.why.positives.map((p) => `<li class="pos">${esc(p)}</li>`).concat(l.why.risks.map((r) => `<li class="neg">${esc(r)}</li>`)).join('') || '<li class="sub">Nothing stands out either way.</li>';
    const site = l.domain ? state.domainInfo[l.domain] : null;
    const siteText = !l.domain ? 'No website' : !site ? (state.api.online ? 'Not checked yet' : 'Not checked (offline mode)') : site.resolves === false ? 'Does not resolve' : site.has_mx === true ? 'Resolves, accepts email' : site.has_mx === false ? 'Resolves, no mail server' : 'Resolves';
    const siteDot = !site ? 'dot-none' : site.resolves === false || site.has_mx === false ? 'dot-bad' : 'dot-ok';
    const phoneDot = l.phone.status === 'valid' ? 'dot-ok' : l.phone.status === 'missing' ? 'dot-none' : 'dot-bad';
    const dups = l.duplicates.length ? `${l.duplicates.length} merged (rows ${l.duplicates.map((d) => d.row).join(', ')})` : 'None';
    const next = {
      contact: 'Reach out now. You have a direct way to the decision maker.',
      enrich: 'Spend a SaaSquatch credit here. It fits, but there is no direct way to reach the owner yet.',
      hold: 'Park it. It is a weak fit for the current thesis.',
      skip: 'Skip it. Poor fit, or nothing to reach it by.',
    }[l.queue];

    $('drawerBody').innerHTML = `
      <div class="d-head">
        <div><h2>${esc(l.company || l.domain)}</h2>
          <div class="sub meta">${l.industry ? `<span>${esc(l.industry)}</span>` : ''}${l.city || l.state ? `<span>${esc([l.city, l.state].filter(Boolean).join(', '))}</span>` : ''}</div>
          ${l.domain ? `<div class="sub"><a href="https://${esc(l.domain)}" target="_blank" rel="noopener noreferrer">${esc(l.domain)}</a></div>` : ''}
        </div>
        <button class="close" type="button" aria-label="Close lead detail">×</button>
      </div>
      <div class="d-score"><b>${l.score}</b><span class="tier tier-${l.tier}">${l.tier}</span><span>${esc(tier.label)}, rank ${l.rank} of ${state.scored.length}</span></div>
      <div class="anatomy" role="img" aria-label="Score breakdown">${anatomy}</div>
      <ul class="factors">${factors}</ul>

      <div class="d-section"><h3>Next step: ${E.QUEUE_LABEL[l.queue]}</h3><p class="sub" style="margin:0 0 8px">${esc(next)}</p><ul class="why">${why}</ul></div>

      <div class="d-section"><h3>Data quality</h3>
        <dl class="kv">
          <dt>Contact</dt><dd>${esc(l.contactName || '—')}${l.title ? ', ' + esc(l.title) : ''}</dd>
          <dt>Email</dt><dd><span class="dot ${emailDot(l)}"></span>${esc(l.emailEffective.address || l.emailRaw || '—')} <span class="sub">${esc(l.emailEffective.label)}</span></dd>
          <dt>Phone</dt><dd><span class="dot ${phoneDot}"></span>${esc(l.phone.display || l.phoneRaw || '—')} <span class="sub">${esc(l.phone.label)}</span></dd>
          <dt>Website</dt><dd><span class="dot ${siteDot}"></span>${esc(siteText)}</dd>
          <dt>Duplicates</dt><dd>${esc(dups)}</dd>
          <dt>Missing</dt><dd>${esc(l.missing.join(', ') || 'Nothing')}</dd>
        </dl>
      </div>

      <div class="d-section"><h3>First-touch message</h3>
        <textarea class="opener" id="opener" aria-label="Message for this lead"></textarea>
        <div class="d-actions">
          <button class="btn btn-primary" type="button" id="copyOpener">Copy message</button>
          ${l.emailEffective.status === 'valid' ? `<a class="btn btn-quiet" id="mailOpener" href="#">Open in email</a>` : ''}
        </div>
      </div>`;
    updateOpener();
    $('drawerBody').querySelector('.close').addEventListener('click', closeDrawer);
    $('copyOpener').addEventListener('click', () => copy($('opener').value, 'Message copied.'));
    const mail = $('mailOpener');
    if (mail) mail.addEventListener('click', (e) => {
      e.preventDefault();
      const subject = encodeURIComponent(l.company ? `Quick question about ${l.company}` : 'Quick question');
      window.location.href = `mailto:${l.emailEffective.address}?subject=${subject}&body=${encodeURIComponent($('opener').value)}`;
    });
  }

  function updateOpener() {
    const l = state.scored.find((x) => x.id === state.selected);
    if (l && $('opener')) $('opener').value = E.renderTemplate(state.thesis.template, l);
  }

  // ------------------------------------------------------------ export, lists

  function download(kind) {
    if (!state.scored.length) return;
    const { filename, csv, count } = E.exportCSV(kind, state.scored);
    if (!count) return toast('Nothing to export in that list yet.');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (state.listName ? state.listName + '-' : '') + filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(`Exported ${count} rows.`);
  }

  async function saveList() {
    $('saveName').value = state.listName || 'Triage list';
    $('saveDialog').showModal();
  }

  async function doSave(name) {
    try {
      const meta = await apiFetch('/api/lists', { method: 'POST', body: JSON.stringify({ name, thesis: state.thesis, leads: state.leads }) });
      state.listName = meta.name;
      toast(`Saved "${meta.name}" (${meta.lead_count} companies).`);
    } catch (e) { toast('Could not save: ' + e.message); }
  }

  async function openLists() {
    $('listsBody').innerHTML = '<p class="sub">Loading…</p>';
    $('listsDialog').showModal();
    try {
      const { lists } = await apiFetch('/api/lists', { method: 'GET' });
      $('listsBody').innerHTML = lists.length
        ? `<ul class="saved">${lists.map((x) => `<li><div><strong>${esc(x.name)}</strong><div class="sub">${x.lead_count} companies, saved ${new Date(x.created_at * 1000).toLocaleString()}</div></div><span><button class="btn btn-quiet" type="button" data-load="${x.id}">Open</button> <button class="link-btn" type="button" data-del="${x.id}">Delete</button></span></li>`).join('')}</ul>`
        : '<p class="sub">No saved lists yet. Import an export and use Save list.</p>';
    } catch (e) { $('listsBody').innerHTML = `<p class="sub">Could not load lists: ${esc(e.message)}</p>`; }
  }

  async function loadList(id) {
    try {
      const data = await apiFetch('/api/lists/' + encodeURIComponent(id), { method: 'GET' });
      state.leads = data.leads;
      state.rowCount = data.leads.reduce((a, l) => a + 1 + (l.duplicates ? l.duplicates.length : 0), 0);
      state.thesis = Object.assign(E.clonePreset(data.thesis.mode || 'acquisition'), data.thesis);
      state.listName = data.name;
      state.isSample = /sample/i.test(data.name);
      state.domainInfo = {};
      state.view = 'contact';
      renderThesis();
      rescore();
      $('empty').hidden = true; $('board').hidden = false; $('funnel').hidden = false;
      $('saveListBtn').disabled = false;
      $('exportMenu').querySelector('summary').removeAttribute('aria-disabled');
      $('listsDialog').close();
      toast(`Opened "${data.name}".`);
      runDomainChecks();
    } catch (e) { toast('Could not open list: ' + e.message); }
  }

  // ------------------------------------------------------------------- misc

  let toastTimer = 0;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3800);
  }

  async function copy(text, ok) {
    try { await navigator.clipboard.writeText(text); toast(ok); }
    catch (e) {
      const ta = $('opener');
      if (ta) { ta.focus(); ta.select(); }
      toast('Press Ctrl+C (or Cmd+C) to copy the selected text.');
    }
  }

  function loadSample() {
    if (!window.TRIAGE_SAMPLE_CSV) return toast('Sample data is not bundled in this build.');
    beginImport(window.TRIAGE_SAMPLE_CSV, SAMPLE_NAME);
  }

  function bind() {
    $('fileInput').addEventListener('change', (e) => { readFile(e.target.files[0]); e.target.value = ''; });
    $('sampleBtn').addEventListener('click', loadSample);
    document.querySelector('[data-action="sample"]').addEventListener('click', loadSample);

    const dz = $('dropZone');
    ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('is-over'); }));
    ['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || e.target === dz) dz.classList.remove('is-over'); }));
    document.addEventListener('drop', (e) => { dz.classList.remove('is-over'); readFile(e.dataTransfer.files[0]); });

    $('mapForm').addEventListener('submit', (e) => {
      if (e.submitter && e.submitter.value === 'ok') {
        if (!confirmMapping()) e.preventDefault();
      } else state.pending = null;
    });

    $('tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-view]');
      if (!b) return;
      state.view = b.dataset.view; state.shown = PAGE; renderTabs(); renderRows();
    });
    $('funnel').addEventListener('click', (e) => {
      const b = e.target.closest('[data-view]');
      if (!b) return;
      state.view = b.dataset.view; state.shown = PAGE; renderTabs(); renderRows();
      $('board').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    let searchTimer = 0;
    $('search').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.query = e.target.value; state.shown = PAGE; renderRows(); }, 120);
    });
    $('moreBtn').addEventListener('click', () => { state.shown += PAGE; renderRows(); });
    $('rows').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) openDrawer(tr.dataset.id); });
    $('rows').addEventListener('keydown', (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (!tr) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrawer(tr.dataset.id); }
      if (e.key === 'ArrowDown' && tr.nextElementSibling) { e.preventDefault(); tr.nextElementSibling.focus(); }
      if (e.key === 'ArrowUp' && tr.previousElementSibling) { e.preventDefault(); tr.previousElementSibling.focus(); }
    });
    $('scrim').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.selected && !document.querySelector('dialog[open]')) closeDrawer(); });

    $('exportMenu').addEventListener('click', (e) => {
      const b = e.target.closest('[data-export]');
      if (!b) return;
      download(b.dataset.export);
      $('exportMenu').open = false;
    });
    document.addEventListener('click', (e) => { if (!e.target.closest('#exportMenu')) $('exportMenu').open = false; });

    $('saveListBtn').addEventListener('click', saveList);
    $('saveForm').addEventListener('submit', (e) => {
      if (e.submitter && e.submitter.value === 'ok') {
        const name = $('saveName').value.trim();
        if (!name) { e.preventDefault(); return; }
        doSave(name);
      }
    });
    $('openListBtn').addEventListener('click', openLists);
    $('listsBody').addEventListener('click', async (e) => {
      const load = e.target.closest('[data-load]');
      const del = e.target.closest('[data-del]');
      if (load) loadList(load.dataset.load);
      if (del) {
        try { await apiFetch('/api/lists/' + encodeURIComponent(del.dataset.del), { method: 'DELETE' }); openLists(); }
        catch (err) { toast('Could not delete: ' + err.message); }
      }
    });
    bindThesis();
  }

  bind();
  renderThesis();
  checkApi();
})();
