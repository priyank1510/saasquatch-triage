// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const E = require('../frontend/engine.js');

const SAMPLE = fs.readFileSync(path.join(__dirname, '..', 'data', 'sample_leads.csv'), 'utf8');

test('parseCSV handles quotes, escaped quotes, embedded newlines, BOM and CRLF', () => {
  const text = '\ufeffName,Notes\r\n"Acme, Inc.","said ""hi""\nthen left"\r\nBeta,plain\r\n';
  const { headers, records } = E.parseCSV(text);
  assert.deepEqual(headers, ['Name', 'Notes']);
  assert.equal(records.length, 2);
  assert.equal(records[0].Name, 'Acme, Inc.');
  assert.equal(records[0].Notes, 'said "hi"\nthen left');
});

test('parseCSV sniffs semicolon and tab delimiters', () => {
  assert.equal(E.parseCSV('a;b\n1;2').records[0].b, '2');
  assert.equal(E.parseCSV('a\tb\n1\t2').records[0].b, '2');
});

test('detectColumns maps varied export headers to canonical fields', () => {
  const m = E.detectColumns(['Business Name', 'Company Website', 'Est. Revenue', '# of Employees', 'Owner Email', 'Job Title', 'First Name', 'Last Name']);
  assert.equal(m.company, 'Business Name');
  assert.equal(m.website, 'Company Website');
  assert.equal(m.revenue, 'Est. Revenue');
  assert.equal(m.employees, '# of Employees');
  assert.equal(m.email, 'Owner Email');
  assert.equal(m.title, 'Job Title');
  assert.equal(m.firstName, 'First Name');
  assert.equal(m.lastName, 'Last Name');
});

test('extractDomain normalizes URLs and rejects junk', () => {
  assert.equal(E.extractDomain('https://www.Acme-HVAC.com/contact?x=1'), 'acme-hvac.com');
  assert.equal(E.extractDomain('www2.acme.co.uk'), 'acme.co.uk');
  assert.equal(E.extractDomain('acme'), '');
  assert.equal(E.extractDomain(''), '');
});

test('checkEmail classifies direct, role, personal, disposable and malformed', () => {
  assert.equal(E.checkEmail('jane@acme.com', 'acme.com').matchesCompany, true);
  assert.equal(E.checkEmail('info@acme.com', 'acme.com').type, 'role');
  assert.equal(E.checkEmail('jane123@gmail.com', 'acme.com').type, 'personal');
  assert.equal(E.checkEmail('jane@mailinator.com').status, 'invalid');
  assert.equal(E.checkEmail('jane@@acme.com').status, 'invalid');
  assert.equal(E.checkEmail('jane.doe@acme').status, 'invalid');
  assert.equal(E.checkEmail('').status, 'missing');
});

test('checkPhone accepts NANP formats and rejects placeholders', () => {
  assert.equal(E.checkPhone('(414) 555-0199').display, '(414) 555-0199');
  assert.equal(E.checkPhone('+1 414 555 0199').e164, '+14145550199');
  assert.equal(E.checkPhone('414.555.0199 ext 12').status, 'valid');
  assert.equal(E.checkPhone('000-000-0000').status, 'invalid');
  assert.equal(E.checkPhone('555-0199').status, 'invalid');
  assert.equal(E.checkPhone('+44 20 7946 0958').label, 'International number');
});

test('parseRange understands the revenue and headcount formats scrapers emit', () => {
  assert.deepEqual(E.parseRange('11-50'), { low: 11, high: 50, mid: 30.5 });
  assert.equal(E.parseRange('$1.2M').mid, 1.2e6);
  assert.equal(E.parseRange('1,250,000').mid, 1.25e6);
  assert.equal(E.parseRange('$450K').mid, 450e3);
  assert.deepEqual(E.parseRange('1-5M'), { low: 1e6, high: 5e6, mid: 3e6 });
  assert.equal(E.parseRange('$1M - $5M').high, 5e6);
  assert.equal(E.parseRange('500+').low, 500);
  assert.equal(E.parseRange('<$1M').high, 1e6);
  assert.equal(E.parseRange('n/a'), null);
});

test('classifyTitle does not mistake a VP for a president', () => {
  assert.equal(E.classifyTitle('Vice President of Sales'), 'executive');
  assert.equal(E.classifyTitle('President'), 'owner');
  assert.equal(E.classifyTitle('Founder & CEO'), 'owner');
  assert.equal(E.classifyTitle('Office Manager'), 'manager');
  assert.equal(E.classifyTitle(''), 'unknown');
});

test('nameKey strips legal suffixes so LLC and Incorporated variants match', () => {
  assert.equal(E.nameKey('Badger Heating & Cooling, LLC'), E.nameKey('Badger Heating and Cooling Incorporated'));
});

test('dedupe merges by domain, by name+state, and by near-identical name', () => {
  const mapping = { company: 'c', website: 'w', state: 's', email: 'e', title: 't', contactName: 'n', phone: 'p' };
  const rows = [
    { c: 'Acme Heating LLC', w: 'https://www.acmeheat.com', s: 'WI', e: 'info@acmeheat.com', n: '', t: '', p: '' },
    { c: 'ACME HEATING', w: 'acmeheat.com/contact', s: 'WI', e: 'joe@acmeheat.com', n: 'Joe Smith', t: 'Owner', p: '(414) 555-0199' },
    { c: 'Acme Heating, Inc.', w: '', s: 'WI', e: '', n: '', t: '', p: '' },
    { c: 'Acme Heatng', w: '', s: 'WI', e: '', n: '', t: '', p: '' },
    { c: 'Acme Heating', w: '', s: 'TX', e: '', n: '', t: '', p: '' }, // different state: separate business
  ].map((r) => E.normalize(r, mapping, { asOfYear: 2026 }));
  const out = E.dedupe(rows);
  assert.equal(out.length, 2);
  const wi = out.find((l) => l.state === 'WI');
  assert.equal(wi.duplicates.length, 3);
  assert.equal(wi.company, 'Acme Heating LLC');
  assert.equal(wi.email.address, 'joe@acmeheat.com', 'keeps the best email from any duplicate');
  assert.equal(wi.seniority, 'owner', 'keeps the most senior contact');
  assert.equal(wi.phone.status, 'valid');
});

test('scoring: in-thesis owner-run business outranks an out-of-thesis one', () => {
  const thesis = E.clonePreset('acquisition');
  const mapping = { company: 'c', industry: 'i', revenue: 'r', employees: 'e', founded: 'f', contactName: 'n', title: 't', email: 'm', website: 'w' };
  const good = E.normalize({ c: 'Good HVAC', i: 'HVAC Services', r: '$4M', e: '30', f: '1990', n: 'Ann Lee', t: 'Owner', m: 'ann@goodhvac.com', w: 'goodhvac.com' }, mapping, { asOfYear: 2026 });
  const bad = E.normalize({ c: 'Tiny Cafe', i: 'Coffee Shop', r: '$200K', e: '4', f: '2022', n: '', t: '', m: 'info@tinycafe.com', w: 'tinycafe.com' }, mapping, { asOfYear: 2026 });
  const [a, b] = E.scoreLeads(E.dedupe([good, bad]), thesis);
  assert.equal(a.company, 'Good HVAC');
  assert.equal(a.tier, 'A');
  assert.equal(a.queue, 'contact');
  assert.ok(b.score < 45, `expected poor fit, got ${b.score}`);
  const sum = a.breakdown.reduce((x, f) => x + f.max, 0);
  assert.ok(Math.abs(sum - 100) < 1e-9, 'factor maxima sum to 100');
});

test('scoring: strong fit with only a shared inbox goes to the enrichment queue', () => {
  const mapping = { company: 'c', industry: 'i', revenue: 'r', employees: 'e', founded: 'f', email: 'm', website: 'w', phone: 'p' };
  const lead = E.normalize({ c: 'Old Pest Co', i: 'Pest Control', r: '$3M', e: '25', f: '1985', m: 'office@oldpest.com', w: 'oldpest.com', p: '(612) 555-0142' }, mapping, { asOfYear: 2026 });
  const [s] = E.scoreLeads(E.dedupe([lead]), E.clonePreset('acquisition'));
  assert.ok(s.tier === 'A' || s.tier === 'B');
  assert.equal(s.queue, 'enrich', 'main line + shared inbox is not a person-level channel');
});

test('MX result from the API downgrades an email whose domain cannot receive mail', () => {
  const mapping = { company: 'c', email: 'm', website: 'w' };
  const lead = E.normalize({ c: 'X', m: 'a@dead-domain.com', w: 'dead-domain.com' }, mapping);
  const [s] = E.scoreLeads(E.dedupe([lead]), E.clonePreset('sales'), { 'dead-domain.com': { has_mx: false, resolves: false } });
  assert.equal(s.emailEffective.status, 'invalid');
});

test('changing weights re-ranks without re-importing', () => {
  const { leads } = E.process(SAMPLE, { asOfYear: 2026 });
  const t1 = E.clonePreset('acquisition');
  const t2 = E.clonePreset('acquisition');
  t2.weights = { revenueFit: 0, sizeFit: 0, tenure: 100, industryFit: 0, recurring: 0, decisionMaker: 0, reachability: 0 };
  const top1 = E.scoreLeads(leads, t1)[0].id;
  const r2 = E.scoreLeads(leads, t2);
  assert.ok(r2[0].years >= 20, 'tenure-only thesis puts the oldest businesses first');
  assert.ok(typeof top1 === 'string');
});

test('sample export: duplicates collapse and the funnel adds up', () => {
  const { rowCount, leads } = E.process(SAMPLE, { asOfYear: 2026 });
  const scored = E.scoreLeads(leads, E.clonePreset('acquisition'));
  const s = E.summarize(rowCount, scored);
  assert.ok(s.duplicatesMerged >= 15, `expected planted duplicates to merge, got ${s.duplicatesMerged}`);
  assert.equal(s.unique, leads.length);
  const q = s.queues;
  assert.equal(q.contact + q.enrich + q.hold + q.skip, s.unique);
  assert.ok(s.creditsSaved > 0);
  assert.ok(scored.every((l) => l.company === l.company.trim()));
  assert.ok(!scored.some((l) => /^[A-Z ]{12,}$/.test(l.company)), 'no ALL-CAPS names survive');
});

test('exports produce well-formed CSV with expected rows', () => {
  const { leads } = E.process(SAMPLE, { asOfYear: 2026 });
  const scored = E.scoreLeads(leads, E.clonePreset('acquisition'));
  const ranked = E.exportCSV('ranked', scored);
  const back = E.parseCSV(ranked.csv);
  assert.equal(back.records.length, scored.length);
  assert.equal(back.records[0].Rank, '1');
  const hub = E.exportCSV('hubspot', scored);
  assert.equal(hub.count, scored.filter((l) => l.queue === 'contact').length);
  assert.ok(E.parseCSV(hub.csv).headers.includes('Company Domain Name'));
  const enrich = E.exportCSV('enrich', scored);
  assert.equal(enrich.count, scored.filter((l) => l.queue === 'enrich').length);
});

test('renderTemplate fills placeholders and degrades gracefully', () => {
  const t = 'Hi {first}, {company} in {city}. {unknown}';
  const out = E.renderTemplate(t, { firstName: '', company: 'Acme', city: 'Omaha' });
  assert.equal(out, 'Hi there, Acme in Omaha. {unknown}');
});

test('scoring 10k leads stays interactive (best of 3 < 600 ms)', () => {
  // Generous bound so shared CI runners don't flake; typical exports are a few hundred rows.
  const { leads } = E.process(SAMPLE, { asOfYear: 2026 });
  const big = [];
  for (let i = 0; i < 10000; i++) big.push(Object.assign({}, leads[i % leads.length], { id: 'X' + i }));
  const thesis = E.clonePreset('acquisition');
  E.scoreLeads(big, thesis); // warm the JIT, as a slider drag would
  let best = Infinity;
  for (let k = 0; k < 3; k++) {
    const t0 = Date.now();
    E.scoreLeads(big, thesis);
    best = Math.min(best, Date.now() - t0);
  }
  assert.ok(best < 600, `took ${best} ms`);
});
