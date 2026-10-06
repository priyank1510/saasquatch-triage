/*
 * Triage engine — pure functions, no DOM. Runs in the browser and in Node (tests).
 *
 * Pipeline:  parseCSV → detectColumns → normalize → dedupe → score → queue → export
 * Scoring is re-run on every thesis change, so it must stay fast: O(n) per pass,
 * no I/O. Dedupe runs once per import.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TriageEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------------ CSV

  function sniffDelimiter(text) {
    const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
    const counts = { ',': 0, ';': 0, '\t': 0 };
    let inQ = false;
    for (const ch of firstLine) {
      if (ch === '"') inQ = !inQ;
      else if (!inQ && ch in counts) counts[ch]++;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0
      ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]
      : ',';
  }

  /** RFC-4180-ish parser: quoted fields, escaped quotes, embedded newlines, BOM. */
  function parseCSV(text) {
    if (!text) return { headers: [], records: [] };
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const delim = sniffDelimiter(text);
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
        continue;
      }
      if (c === '"') inQuotes = true;
      else if (c === delim) { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c !== '\r') field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }

    const nonEmpty = rows.filter((r) => r.some((v) => v.trim() !== ''));
    if (!nonEmpty.length) return { headers: [], records: [] };
    const headers = nonEmpty[0].map((h) => h.trim());
    const records = nonEmpty.slice(1).map((r) => {
      const o = {};
      headers.forEach((h, idx) => { o[h] = (r[idx] == null ? '' : r[idx]).trim(); });
      return o;
    });
    return { headers, records };
  }

  function csvEscape(v) {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCSV(headers, rows) {
    const lines = [headers.map(csvEscape).join(',')];
    for (const r of rows) lines.push(headers.map((h) => csvEscape(r[h])).join(','));
    return lines.join('\r\n');
  }

  // ------------------------------------------------------- Column mapping

  /** Canonical fields and the header names we have seen for them in lead exports. */
  const FIELDS = {
    company: { label: 'Company name', synonyms: ['company', 'company name', 'business', 'business name', 'organization', 'organisation', 'account', 'account name', 'name'] },
    website: { label: 'Website', synonyms: ['website', 'domain', 'url', 'web', 'site', 'company website', 'website url', 'company domain', 'company url'] },
    industry: { label: 'Industry', synonyms: ['industry', 'category', 'sector', 'vertical', 'business type', 'niche', 'sub industry', 'naics description'] },
    employees: { label: 'Employees', synonyms: ['employees', 'employee count', 'number of employees', 'headcount', 'company size', 'staff', 'employee range', 'est employees', 'estimated employees'] },
    revenue: { label: 'Revenue', synonyms: ['revenue', 'annual revenue', 'estimated revenue', 'est revenue', 'revenue estimate', 'revenue range', 'sales volume'] },
    founded: { label: 'Year founded', synonyms: ['founded', 'year founded', 'founded year', 'established', 'year established', 'year started'] },
    yearsInBusiness: { label: 'Years in business', synonyms: ['years in business', 'years operating', 'business age'] },
    city: { label: 'City', synonyms: ['city', 'town', 'locality'] },
    state: { label: 'State', synonyms: ['state', 'province', 'region', 'state province', 'state region'] },
    country: { label: 'Country', synonyms: ['country', 'country code'] },
    contactName: { label: 'Contact name', synonyms: ['owner', 'owner name', 'contact', 'contact name', 'full name', 'person', 'person name', 'decision maker', 'lead name'] },
    firstName: { label: 'First name', synonyms: ['first name', 'firstname', 'given name', 'owner first name'] },
    lastName: { label: 'Last name', synonyms: ['last name', 'lastname', 'surname', 'family name', 'owner last name'] },
    title: { label: 'Job title', synonyms: ['title', 'job title', 'position', 'role', 'owner title', 'contact title', 'designation'] },
    email: { label: 'Email', synonyms: ['email', 'email address', 'e mail', 'owner email', 'contact email', 'work email', 'business email'] },
    phone: { label: 'Phone', synonyms: ['phone', 'phone number', 'telephone', 'tel', 'mobile', 'company phone', 'owner phone', 'direct phone', 'contact phone'] },
    linkedin: { label: 'LinkedIn', synonyms: ['linkedin', 'linkedin url', 'linkedin profile', 'owner linkedin', 'contact linkedin', 'company linkedin'] },
  };

  function normHeader(h) {
    return String(h).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  /**
   * Map arbitrary export headers to canonical fields.
   * Exact synonym beats "header contains synonym"; each header is used once.
   * Returns { field: headerName }.
   */
  function detectColumns(headers) {
    const candidates = [];
    headers.forEach((h) => {
      const nh = normHeader(h);
      for (const [field, def] of Object.entries(FIELDS)) {
        def.synonyms.forEach((syn, rank) => {
          let score = 0;
          if (nh === syn) score = 100 - rank;
          else if (syn.length > 3 && new RegExp('(^| )' + syn + '( |$)').test(nh)) score = 50 - rank;
          if (score) candidates.push({ field, header: h, score });
        });
      }
    });
    candidates.sort((a, b) => b.score - a.score);
    const mapping = {};
    const usedHeaders = new Set();
    for (const c of candidates) {
      if (mapping[c.field] || usedHeaders.has(c.header)) continue;
      mapping[c.field] = c.header;
      usedHeaders.add(c.header);
    }
    return mapping;
  }

  // -------------------------------------------------------- Normalization

  const LEGAL_SUFFIX = /\b(inc|incorporated|llc|l l c|ltd|limited|corp|corporation|co|company|pllc|plc|lp|llp|pc|pa)\b/g;

  function nameKey(name) {
    return String(name || '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(LEGAL_SUFFIX, ' ')
      .replace(/\bthe\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function extractDomain(value) {
    if (!value) return '';
    let d = String(value).trim().toLowerCase();
    if (d.includes('@') && !d.includes('/')) d = d.split('@').pop();
    d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^www\d?\./, '');
    d = d.split(/[/?#:\s]/)[0].replace(/\.$/, '');
    return /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(d) ? d : '';
  }

  const FREE_EMAIL = new Set(['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com', 'me.com', 'msn.com', 'live.com', 'comcast.net', 'att.net', 'sbcglobal.net', 'verizon.net', 'protonmail.com', 'proton.me', 'ymail.com', 'mail.com', 'gmx.com', 'charter.net', 'cox.net', 'bellsouth.net']);
  const DISPOSABLE_EMAIL = new Set(['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'temp-mail.org', 'trashmail.com', 'yopmail.com', 'getnada.com', 'sharklasers.com', 'dispostable.com', 'maildrop.cc', 'throwawaymail.com', 'fakeinbox.com']);
  const ROLE_LOCALPARTS = new Set(['info', 'sales', 'contact', 'admin', 'support', 'office', 'hello', 'service', 'services', 'help', 'team', 'enquiries', 'inquiries', 'billing', 'accounts', 'mail', 'marketing', 'hr', 'jobs', 'careers', 'noreply', 'no-reply', 'webmaster', 'reception', 'frontdesk', 'customerservice']);
  const EMAIL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

  /** Classify an email without network access. Domain MX is applied later from the API. */
  function checkEmail(email, companyDomain) {
    const e = String(email || '').trim().toLowerCase().replace(/^mailto:/, '');
    if (!e) return { status: 'missing', label: 'No email' };
    if (!EMAIL_RE.test(e)) return { status: 'invalid', label: 'Malformed address', address: e };
    const [local, domain] = e.split('@');
    if (DISPOSABLE_EMAIL.has(domain)) return { status: 'invalid', label: 'Disposable inbox', address: e, domain };
    const base = local.split('+')[0];
    let type = 'direct';
    if (ROLE_LOCALPARTS.has(base)) type = 'role';
    else if (FREE_EMAIL.has(domain)) type = 'personal';
    const matchesCompany = !!companyDomain && (domain === companyDomain || domain.endsWith('.' + companyDomain));
    const label = type === 'role' ? 'Shared inbox' : type === 'personal' ? 'Personal address' : matchesCompany ? 'Direct, company domain' : 'Direct address';
    return { status: 'valid', type, matchesCompany, address: e, domain, label };
  }

  function checkPhone(phone) {
    const raw = String(phone || '').trim();
    if (!raw) return { status: 'missing', label: 'No phone' };
    const hadPlus = raw.startsWith('+');
    const digits = raw.replace(/\s*(ext\.?|x)\s*\d+$/i, '').replace(/[^0-9]/g, '');
    if (/^(\d)\1+$/.test(digits)) return { status: 'invalid', label: 'Placeholder number', raw };
    let us = null;
    if (!hadPlus && digits.length === 10) us = digits;
    else if (digits.length === 11 && digits[0] === '1') us = digits.slice(1);
    if (us) {
      // NANP: area code and exchange cannot start with 0 or 1
      if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(us)) return { status: 'invalid', label: 'Not a valid US number', raw };
      return { status: 'valid', label: 'US number', display: `(${us.slice(0, 3)}) ${us.slice(3, 6)}-${us.slice(6)}`, e164: '+1' + us };
    }
    if (hadPlus && digits.length >= 8 && digits.length <= 15) return { status: 'valid', label: 'International number', display: raw, e164: '+' + digits };
    return { status: 'invalid', label: 'Unrecognized format', raw };
  }

  const MULTIPLIERS = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, mil: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 };

  function parseAmount(s) {
    const t = String(s).toLowerCase().replace(/[$€£,\s]|usd/g, '');
    const m = t.match(/^(\d+(?:\.\d+)?)(k|thousand|mm|mil|million|m|bn|billion|b)?/);
    if (!m) return null;
    return { n: parseFloat(m[1]), mult: m[2] ? MULTIPLIERS[m[2]] : null };
  }

  /** "11-50", "$1M - $5M", "1-5M", "500+", "<$1M", "1,250,000", "$450K" → {low, high, mid} */
  function parseRange(value) {
    if (value == null) return null;
    let s = String(value).trim();
    if (!s || /^(n\/?a|unknown|-|none|null)$/i.test(s)) return null;
    let lessThan = false;
    let plus = false;
    if (/^(<|under|less than|up to)/i.test(s)) { lessThan = true; s = s.replace(/^(<|under|less than|up to)\s*/i, ''); }
    if (/\+\s*$|or more$/i.test(s)) { plus = true; s = s.replace(/\+\s*$|or more$/i, ''); }
    const parts = s.split(/\s*(?:–|—|-|\bto\b)\s*/i).filter((p) => p.trim() !== '');
    const nums = parts.map(parseAmount).filter(Boolean);
    if (!nums.length) return null;
    const unit = nums.map((x) => x.mult).filter(Boolean).pop() || 1;
    const vals = nums.map((x) => x.n * (x.mult || unit));
    let low = Math.min(...vals);
    let high = Math.max(...vals);
    if (lessThan) { high = low; low = 0; }
    if (plus) high = low * 1.5;
    return { low, high, mid: lessThan ? high * 0.6 : (low + high) / 2 };
  }

  function classifyTitle(title) {
    const s = String(title || '').toLowerCase();
    if (!s.trim()) return 'unknown';
    if (/\b(vice president|vp|svp|evp)\b/.test(s)) return 'executive';
    if (/\b(owner|co ?-?owner|founder|co ?-?founder|proprietor|principal|president|ceo|chief executive|managing (partner|member))\b/.test(s)) return 'owner';
    if (/\b(chief|cfo|coo|cto|cmo|cro|partner|general manager|gm|managing director)\b/.test(s)) return 'executive';
    if (/\b(director|head of)\b/.test(s)) return 'director';
    if (/\b(manager|lead|supervisor|superintendent)\b/.test(s)) return 'manager';
    return 'staff';
  }

  const SENIORITY_LABEL = { owner: 'Owner / founder', executive: 'Executive', director: 'Director', manager: 'Manager', staff: 'Staff', unknown: 'Unknown role' };

  /** Industry taxonomy tuned to lower-middle-market targets. Order matters: first match wins. */
  const INDUSTRY_GROUPS = [
    ['IT & software', ['managed it', 'managed service', 'it services', 'it support', 'msp', 'software', 'saas', 'cybersecurity', 'web development', 'computer', 'technology', 'data center']],
    ['Healthcare services', ['dental', 'dentist', 'orthodont', 'physical therapy', 'chiropract', 'veterinar', 'animal hospital', 'home health', 'medical billing', 'optometr', 'pharmacy', 'clinic', 'medical', 'health']],
    ['Home services', ['hvac', 'heating', 'air conditioning', 'cooling', 'plumbing', 'plumber', 'electrical', 'electrician', 'roofing', 'landscap', 'lawn', 'pest', 'residential cleaning', 'maid', 'painting', 'pool', 'garage door', 'restoration', 'home services', 'tree service', 'fencing', 'remodel']],
    ['B2B services', ['staffing', 'accounting', 'bookkeeping', 'payroll', 'cpa', 'consulting', 'marketing agency', 'logistics', 'freight', 'courier', 'trucking', 'commercial cleaning', 'janitorial', 'facilities', 'printing', 'insurance agency', 'insurance', 'engineering', 'security services', 'alarm', 'waste', 'environmental services', 'testing lab', 'laboratory', 'legal services', 'translation']],
    ['Industrial', ['manufactur', 'machining', 'machine shop', 'fabricat', 'metal', 'packaging', 'industrial', 'distribut', 'wholesale', 'equipment rental', 'welding', 'plastics', 'tool and die', 'cnc']],
    ['Consumer & retail', ['restaurant', 'retail', 'boutique', 'salon', 'spa', 'fitness', 'gym', 'cafe', 'coffee', 'bakery', 'apparel', 'florist', 'bar', 'food truck', 'car wash']],
  ];
  const INDUSTRY_GROUP_NAMES = INDUSTRY_GROUPS.map((g) => g[0]);

  /** Businesses where revenue usually repeats: contracts, maintenance plans, subscriptions. */
  const RECURRING_KEYWORDS = ['managed', 'maintenance', 'pest', 'landscap', 'lawn', 'janitorial', 'commercial cleaning', 'payroll', 'bookkeeping', 'accounting', 'alarm', 'monitoring', 'waste', 'software', 'saas', 'msp', 'it support', 'pool', 'insurance', 'staffing', 'medical billing', 'equipment rental', 'hvac'];

  function industryGroup(industry) {
    const s = String(industry || '').toLowerCase();
    if (!s.trim()) return null;
    for (const [group, kws] of INDUSTRY_GROUPS) if (kws.some((k) => s.includes(k))) return group;
    return 'Other';
  }

  function isRecurring(industry) {
    const s = String(industry || '').toLowerCase();
    return RECURRING_KEYWORDS.some((k) => s.includes(k));
  }

  function splitName(full) {
    const parts = String(full || '').trim().replace(/\s+/g, ' ').split(' ').filter(Boolean);
    if (!parts.length) return { first: '', last: '' };
    return { first: parts[0], last: parts.slice(1).join(' ') };
  }

  function titleCase(s) {
    return String(s || '').toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
  }

  const KEEP_UPPER = new Set(['LLC', 'LLP', 'PLLC', 'IT', 'HVAC', 'CNC', 'USA', 'PC', 'PA', 'LP', 'CPA', 'MSP', 'AV', 'RV']);

  /** "BLUESTEM ANIMAL HOSPITAL LLC" → "Bluestem Animal Hospital LLC"; leaves mixed case alone. */
  function tidyCompanyName(name) {
    const s = String(name || '').replace(/\s+/g, ' ').trim();
    if (!s || s !== s.toUpperCase() || !/[A-Z]{4,}/.test(s)) return s;
    return s.split(' ').map((w) => (KEEP_UPPER.has(w.replace(/[^A-Z]/g, '')) ? w : titleCase(w))).join(' ');
  }

  /** Turn one raw CSV record into a typed lead. Never throws on bad input. */
  function normalize(record, mapping, opts) {
    const asOfYear = (opts && opts.asOfYear) || new Date().getFullYear();
    const get = (f) => (mapping[f] ? String(record[mapping[f]] || '').trim() : '');

    const company = tidyCompanyName(get('company'));
    const emailRaw = get('email');
    let domain = extractDomain(get('website'));
    const domainFromWebsite = !!domain;
    const emailDomain = extractDomain(emailRaw.includes('@') ? emailRaw.split('@').pop() : '');
    if (!domain && emailDomain && !FREE_EMAIL.has(emailDomain) && !DISPOSABLE_EMAIL.has(emailDomain)) domain = emailDomain;

    let first = get('firstName');
    let last = get('lastName');
    let contactName = get('contactName');
    if (!contactName && (first || last)) contactName = (first + ' ' + last).trim();
    if (contactName && !first) ({ first, last } = splitName(contactName));
    if (contactName === contactName.toUpperCase() || contactName === contactName.toLowerCase()) contactName = titleCase(contactName);
    if (first === first.toUpperCase() || first === first.toLowerCase()) first = titleCase(first);

    let founded = parseInt(get('founded').replace(/[^0-9]/g, '').slice(0, 4), 10);
    if (!(founded >= 1800 && founded <= asOfYear)) founded = null;
    let years = founded ? asOfYear - founded : null;
    const yearsRaw = parseFloat(get('yearsInBusiness'));
    if (years == null && yearsRaw >= 0 && yearsRaw < 250) { years = Math.round(yearsRaw); founded = asOfYear - years; }

    const industry = get('industry');
    const title = get('title');
    const lead = {
      company,
      tidiedFromCaps: company !== get('company').replace(/\s+/g, ' ').trim(),
      nameKey: nameKey(company),
      website: get('website'),
      domain,
      domainFromWebsite,
      industry,
      industryGroup: industryGroup(industry),
      recurring: isRecurring(industry),
      employees: parseRange(get('employees')),
      employeesRaw: get('employees'),
      revenue: parseRange(get('revenue')),
      revenueRaw: get('revenue'),
      founded,
      years,
      city: titleCase(get('city')),
      state: get('state').length <= 3 ? get('state').toUpperCase() : titleCase(get('state')),
      country: get('country'),
      contactName,
      firstName: first,
      lastName: last,
      title,
      seniority: classifyTitle(title),
      emailRaw,
      email: checkEmail(emailRaw, domain),
      phoneRaw: get('phone'),
      phone: checkPhone(get('phone')),
      linkedin: get('linkedin'),
    };
    return lead;
  }

  const COMPLETENESS_FIELDS = [
    ['company', (l) => !!l.company], ['website', (l) => !!l.domain], ['industry', (l) => !!l.industry],
    ['employees', (l) => !!l.employees], ['revenue', (l) => !!l.revenue], ['year founded', (l) => l.years != null],
    ['contact name', (l) => !!l.contactName], ['title', (l) => !!l.title],
    ['email', (l) => l.email.status === 'valid'], ['phone', (l) => l.phone.status === 'valid'],
  ];

  function missingFields(lead) {
    return COMPLETENESS_FIELDS.filter(([, has]) => !has(lead)).map(([name]) => name);
  }

  // ---------------------------------------------------------------- Dedupe

  function bigrams(s) {
    const out = new Map();
    const t = ' ' + s + ' ';
    for (let i = 0; i < t.length - 1; i++) {
      const g = t.slice(i, i + 2);
      out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
  }

  /** Sørensen–Dice similarity on character bigrams, 0..1. */
  function similarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const A = bigrams(a);
    const B = bigrams(b);
    let inter = 0;
    let total = 0;
    for (const [g, n] of A) { total += n; if (B.has(g)) inter += Math.min(n, B.get(g)); }
    for (const n of B.values()) total += n;
    return (2 * inter) / total;
  }

  /**
   * Typo-tolerant name match. The whole key must be close (≥ 0.88) AND the first,
   * most distinctive word must be close too, so "Copper Precision Machining" and
   * "Juniper Precision Machining" (0.84 overall) stay separate businesses.
   */
  function similarName(a, b) {
    if (similarity(a, b) < 0.88) return false;
    const fa = a.split(' ')[0];
    const fb = b.split(' ')[0];
    return fa === fb || similarity(fa, fb) >= 0.75;
  }

  const EMAIL_RANK = { direct: 3, personal: 2, role: 1 };

  function emailRank(e) {
    if (!e || e.status !== 'valid') return 0;
    return EMAIL_RANK[e.type] + (e.matchesCompany ? 1 : 0);
  }

  function mergeInto(target, src) {
    const simple = ['company', 'website', 'industry', 'industryGroup', 'employeesRaw', 'revenueRaw', 'founded', 'years', 'city', 'state', 'country', 'linkedin'];
    for (const k of simple) if ((target[k] == null || target[k] === '') && src[k] != null && src[k] !== '') target[k] = src[k];
    if (target.tidiedFromCaps && src.company && !src.tidiedFromCaps) target.company = src.company;
    if (!target.domain && src.domain) { target.domain = src.domain; target.domainFromWebsite = src.domainFromWebsite; }
    if (!target.employees && src.employees) target.employees = src.employees;
    if (!target.revenue && src.revenue) target.revenue = src.revenue;
    if (!target.recurring && src.recurring) target.recurring = true;
    // Contact: keep the most senior person, then the best email.
    const order = ['owner', 'executive', 'director', 'manager', 'staff', 'unknown'];
    const srcBetter = order.indexOf(src.seniority) < order.indexOf(target.seniority);
    if (srcBetter && src.contactName) {
      for (const k of ['contactName', 'firstName', 'lastName', 'title', 'seniority']) target[k] = src[k];
    } else if (!target.contactName && src.contactName) {
      for (const k of ['contactName', 'firstName', 'lastName', 'title', 'seniority']) target[k] = src[k];
    }
    if (emailRank(src.email) > emailRank(target.email)) { target.email = src.email; target.emailRaw = src.emailRaw; }
    if (target.phone.status !== 'valid' && src.phone.status === 'valid') { target.phone = src.phone; target.phoneRaw = src.phoneRaw; }
    if (target.email.status === 'valid') target.email = checkEmail(target.email.address, target.domain);
  }

  /**
   * Collapse duplicate companies. Match order:
   *  1. same domain
   *  2. same normalized name + state
   *  3. typo-tolerant name match (see similarName) within a blocking key (first 3 chars + state), domains not conflicting
   */
  function dedupe(leads) {
    const groups = [];
    const byKey = new Map();
    const blocks = new Map();
    const blockKey = (l) => l.nameKey.slice(0, 3) + '|' + (l.state || '').toLowerCase();

    const register = (g, l) => {
      if (l.domain) byKey.set('d:' + l.domain, g);
      if (l.nameKey) byKey.set('n:' + l.nameKey + '|' + (l.state || '').toLowerCase(), g);
      if (l.nameKey) {
        const bk = blockKey(l);
        if (!blocks.has(bk)) blocks.set(bk, []);
        if (!blocks.get(bk).includes(g)) blocks.get(bk).push(g);
      }
    };

    leads.forEach((lead, rowIndex) => {
      if (!lead.company && !lead.domain) return; // nothing to identify it by
      let g = null;
      let matchedBy = null;
      if (lead.domain && byKey.has('d:' + lead.domain)) { g = byKey.get('d:' + lead.domain); matchedBy = 'domain'; }
      const nk = 'n:' + lead.nameKey + '|' + (lead.state || '').toLowerCase();
      if (!g && lead.nameKey && byKey.has(nk)) {
        const cand = byKey.get(nk);
        if (!lead.domain || !cand.domain || cand.domain === lead.domain) { g = cand; matchedBy = 'name'; }
      }
      if (!g && lead.nameKey) {
        for (const cand of blocks.get(blockKey(lead)) || []) {
          if (lead.domain && cand.domain && cand.domain !== lead.domain) continue;
          if (similarName(cand.nameKey, lead.nameKey)) { g = cand; matchedBy = 'similar name'; break; }
        }
      }
      if (g) {
        mergeInto(g, lead);
        g.duplicates.push({ row: rowIndex + 2, matchedBy, company: lead.company });
        register(g, lead);
      } else {
        const copy = Object.assign({}, lead, { id: 'L' + (groups.length + 1), sourceRow: rowIndex + 2, duplicates: [] });
        groups.push(copy);
        register(copy, copy);
      }
    });
    return groups;
  }

  // --------------------------------------------------------------- Scoring

  const FACTORS = {
    revenueFit: { label: 'Revenue fit', color: 'f1' },
    sizeFit: { label: 'Team size fit', color: 'f2' },
    tenure: { label: 'Operating history', color: 'f3' },
    industryFit: { label: 'Industry fit', color: 'f4' },
    recurring: { label: 'Recurring revenue', color: 'f5' },
    decisionMaker: { label: 'Decision-maker contact', color: 'f6' },
    reachability: { label: 'Reachability', color: 'f7' },
  };

  const PRESETS = {
    acquisition: {
      mode: 'acquisition',
      label: 'Acquisition sourcing',
      revenue: { min: 1e6, max: 10e6 },
      employees: { min: 10, max: 100 },
      minYears: 10,
      industries: ['Home services', 'B2B services', 'IT & software', 'Healthcare services', 'Industrial'],
      weights: { revenueFit: 25, sizeFit: 10, tenure: 15, industryFit: 15, recurring: 10, decisionMaker: 15, reachability: 10 },
      template: 'Hi {first},\n\nI came across {company} while researching {industry} businesses in {city}. {tenure_line}I work with Caprae Capital, where we partner with owners who are thinking about the next chapter for their business, whether that is growth, a partial sale, or succession.\n\nWould you be open to a 15-minute call next week? No pressure either way.',
    },
    sales: {
      mode: 'sales',
      label: 'Sales outreach',
      revenue: { min: 2e6, max: 50e6 },
      employees: { min: 20, max: 500 },
      minYears: 3,
      industries: ['Home services', 'B2B services', 'IT & software', 'Healthcare services', 'Industrial'],
      weights: { revenueFit: 15, sizeFit: 20, tenure: 5, industryFit: 20, recurring: 0, decisionMaker: 20, reachability: 20 },
      template: 'Hi {first},\n\nTeams like {company}, with around {employees} people, usually hit the point where manual work starts slowing growth. We help {industry} companies in {city} win back those hours.\n\nWorth a quick 15-minute look next week?',
    },
  };

  const UNKNOWN = 0.35; // partial credit for missing data: unknown should rank below known-good, above known-bad

  function bandFit(value, min, max) {
    if (value == null) return UNKNOWN;
    if (value >= min && value <= max) return 1;
    const ratio = value < min ? min / Math.max(value, 1) : value / max;
    return Math.max(0, 1 - Math.log2(ratio) / 2); // 0 once 4× outside the band
  }

  function money(n) {
    if (n == null) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }

  function count(n) {
    if (n == null) return '—';
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function rangeLabel(r, fmt) {
    if (!r) return '—';
    if (r.low === r.high) return fmt(r.low);
    if (r.low === 0) return 'under ' + fmt(r.high);
    return fmt(r.low) + '–' + fmt(r.high);
  }

  function factorValues(lead, thesis, domainInfo) {
    const out = {};
    // Revenue
    const rev = lead.revenue ? lead.revenue.mid : null;
    out.revenueFit = { v: bandFit(rev, thesis.revenue.min, thesis.revenue.max), note: rev == null ? 'No revenue estimate' : `Est. ${rangeLabel(lead.revenue, money)} vs target ${money(thesis.revenue.min)}–${money(thesis.revenue.max)}` };
    // Size
    const emp = lead.employees ? lead.employees.mid : null;
    out.sizeFit = { v: bandFit(emp, thesis.employees.min, thesis.employees.max), note: emp == null ? 'No headcount' : `${rangeLabel(lead.employees, count)} employees vs target ${thesis.employees.min}–${thesis.employees.max}` };
    // Tenure
    let tv = UNKNOWN;
    let tnote = 'Founding year unknown';
    if (lead.years != null) {
      const min = Math.max(thesis.minYears, 1);
      tv = lead.years >= min * 2 ? 1 : lead.years >= min ? 0.8 : 0.8 * (lead.years / min);
      tnote = `${lead.years} years in business (since ${lead.founded})`;
    }
    out.tenure = { v: tv, note: tnote };
    // Industry
    let iv = 0.3;
    let inote = 'No industry listed';
    if (lead.industryGroup) {
      iv = thesis.industries.includes(lead.industryGroup) ? 1 : 0.1;
      inote = `${lead.industry} → ${lead.industryGroup}${iv === 1 ? '' : ' (outside thesis)'}`;
    }
    out.industryFit = { v: iv, note: inote };
    // Recurring
    out.recurring = lead.industry
      ? { v: lead.recurring ? 1 : 0.2, note: lead.recurring ? 'Service-contract or subscription style business' : 'Mostly project or transactional revenue' }
      : { v: 0.3, note: 'No industry listed' };
    // Decision maker
    const dmTable = thesis.mode === 'acquisition'
      ? { owner: 1, executive: 0.55, director: 0.35, manager: 0.2, staff: 0.1, unknown: 0.2 }
      : { owner: 1, executive: 0.9, director: 0.75, manager: 0.45, staff: 0.15, unknown: 0.2 };
    let dv = dmTable[lead.seniority];
    if (lead.seniority === 'unknown' && lead.contactName) dv = 0.35;
    out.decisionMaker = { v: dv, note: lead.contactName ? (lead.title ? `${lead.contactName}, ${lead.title}` : `${lead.contactName} (title unknown)`) : 'No named contact' };
    // Reachability
    const e = effectiveEmail(lead, domainInfo);
    let ev = 0;
    if (e.status === 'valid') ev = e.type === 'direct' ? (e.matchesCompany ? 0.65 : 0.55) : e.type === 'personal' ? 0.5 : 0.25;
    const pv = lead.phone.status === 'valid' ? (lead.contactName ? 0.3 : 0.15) : 0;
    const lv = lead.linkedin ? 0.05 : 0;
    let rv = Math.min(1, ev + pv + lv);
    const site = domainInfo && lead.domain ? domainInfo[lead.domain] : null;
    if (site && site.resolves === false) rv *= 0.7;
    const bits = [e.label, lead.phone.status === 'valid' ? (lead.contactName ? 'phone ok' : 'main line only') : lead.phone.label.toLowerCase()];
    if (site && site.resolves === false) bits.push('website domain does not resolve');
    out.reachability = { v: rv, note: bits.join(', ') };
    return out;
  }

  /** Email status after applying the API's MX result for its domain (if we have one). */
  function effectiveEmail(lead, domainInfo) {
    const e = lead.email;
    if (e.status !== 'valid' || !domainInfo) return e;
    const info = domainInfo[e.domain];
    if (info && info.has_mx === false) return Object.assign({}, e, { status: 'invalid', label: 'Domain cannot receive email' });
    if (info && info.has_mx === true) return Object.assign({}, e, { mxVerified: true, label: e.label + ', MX verified' });
    return e;
  }

  const TIERS = [
    { id: 'A', min: 80, label: 'Strong fit' },
    { id: 'B', min: 65, label: 'Good fit' },
    { id: 'C', min: 45, label: 'Weak fit' },
    { id: 'D', min: 0, label: 'Poor fit' },
  ];

  function tierFor(score) {
    return TIERS.find((t) => score >= t.min).id;
  }

  /**
   * Queue = the next action. This is where enrichment credits get saved:
   *  contact  — strong/good fit and already reachable by a person-level channel
   *  enrich   — strong/good fit but missing a usable email or phone → spend a credit
   *  hold     — weak fit; revisit if the thesis changes
   *  skip     — poor fit or nothing to identify / reach it by
   */
  function queueFor(tier, lead, email) {
    const reachable = personReachable(lead, email);
    if (!lead.domain && !reachable) return 'skip';
    if (tier === 'A' || tier === 'B') return reachable ? 'contact' : 'enrich';
    if (tier === 'C') return 'hold';
    return 'skip';
  }

  /**
   * Can we reach a specific person today without spending a credit?
   * A personal/direct inbox counts. A phone counts only when we know who we're calling;
   * a company main line with no name is what enrichment is for.
   */
  function personReachable(lead, email) {
    const e = email || lead.emailEffective || lead.email;
    return (e.status === 'valid' && e.type !== 'role') || (!!lead.contactName && lead.phone.status === 'valid');
  }

  function reasons(lead, thesis, f) {
    const out = [];
    if (thesis.mode === 'acquisition') {
      if (lead.years != null && lead.years >= 25) out.push(`${lead.years} years in operation; succession is a natural conversation`);
      else if (lead.years != null && lead.years >= thesis.minYears) out.push(`${lead.years}-year operating history`);
    }
    if (f.revenueFit.v === 1) out.push(`Revenue ${rangeLabel(lead.revenue, money)} is inside your band`);
    if (lead.recurring && thesis.weights.recurring > 0) out.push('Likely recurring revenue');
    if (lead.seniority === 'owner') out.push('Owner is the named contact');
    if (f.sizeFit.v === 1 && thesis.mode === 'sales') out.push(`${rangeLabel(lead.employees, count)} employees, inside your size band`);
    const risks = [];
    if (lead.email.status === 'invalid') risks.push(lead.email.label);
    if (lead.email.status === 'valid' && lead.email.type === 'role') risks.push('Only a shared inbox');
    if (f.industryFit.v < 0.5 && lead.industryGroup) risks.push('Industry outside thesis');
    if (lead.revenue && f.revenueFit.v < 0.5) risks.push(lead.revenue.mid < thesis.revenue.min ? 'Smaller than target' : 'Larger than target');
    return { positives: out.slice(0, 3), risks: risks.slice(0, 2) };
  }

  /** Score every lead against a thesis. Pure; safe to call on every slider move. */
  function scoreLeads(leads, thesis, domainInfo) {
    const wTotal = Object.values(thesis.weights).reduce((a, b) => a + b, 0) || 1;
    const scored = leads.map((lead) => {
      const f = factorValues(lead, thesis, domainInfo);
      const breakdown = Object.keys(FACTORS).map((k) => {
        const max = (thesis.weights[k] / wTotal) * 100;
        return { key: k, label: FACTORS[k].label, color: FACTORS[k].color, points: f[k].v * max, max, note: f[k].note, value: f[k].v };
      });
      const score = Math.round(breakdown.reduce((a, b) => a + b.points, 0));
      const email = effectiveEmail(lead, domainInfo);
      const tier = tierFor(score);
      return Object.assign({}, lead, {
        score, tier, breakdown, emailEffective: email,
        queue: queueFor(tier, lead, email),
        missing: missingFields(lead),
        why: reasons(lead, thesis, f),
      });
    });
    scored.sort((a, b) => b.score - a.score || (a.company < b.company ? -1 : a.company > b.company ? 1 : 0));
    scored.forEach((l, i) => { l.rank = i + 1; });
    return scored;
  }

  function isReachable(l) {
    return personReachable(l);
  }

  function summarize(rowCount, scored) {
    const by = (k, v) => scored.filter((l) => l[k] === v).length;
    const reachable = scored.filter(isReachable).length;
    const enrich = by('queue', 'enrich');
    const unreachable = scored.length - reachable;
    return {
      rows: rowCount,
      unique: scored.length,
      duplicatesMerged: scored.reduce((a, l) => a + l.duplicates.length, 0),
      reachable,
      strongFit: scored.filter((l) => l.tier === 'A' || l.tier === 'B').length,
      tiers: { A: by('tier', 'A'), B: by('tier', 'B'), C: by('tier', 'C'), D: by('tier', 'D') },
      queues: { contact: by('queue', 'contact'), enrich, hold: by('queue', 'hold'), skip: by('queue', 'skip') },
      creditsIfEnrichAll: unreachable,
      creditsSaved: Math.max(0, unreachable - enrich),
      invalidEmails: scored.filter((l) => (l.emailEffective || l.email).status === 'invalid').length,
    };
  }

  // ------------------------------------------------------------- Outreach

  function renderTemplate(template, lead) {
    const tenure = lead.years != null && lead.years >= 5 ? `${lead.years} years is a real track record. ` : '';
    const vars = {
      first: lead.firstName || 'there',
      company: lead.company || 'your company',
      city: lead.city || 'your area',
      industry: (lead.industry || 'local').toLowerCase(),
      employees: lead.employees ? Math.round(lead.employees.mid) : 'a few dozen',
      years: lead.years != null ? lead.years : '',
      title: lead.title || '',
      tenure_line: tenure,
    };
    return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  }

  // --------------------------------------------------------------- Export

  const EXPORTS = {
    ranked: {
      label: 'Ranked list (CSV)',
      filename: 'triage-ranked.csv',
      headers: ['Rank', 'Tier', 'Score', 'Next step', 'Company', 'Website', 'Industry', 'Employees', 'Revenue', 'Year founded', 'City', 'State', 'Contact', 'Title', 'Email', 'Email status', 'Phone', 'LinkedIn', 'Why', 'Risks', 'Missing', 'Duplicates merged'],
      row: (l, ctx) => ({
        Rank: l.rank, Tier: l.tier, Score: l.score, 'Next step': QUEUE_LABEL[l.queue], Company: l.company, Website: l.domain,
        Industry: l.industry, Employees: l.employeesRaw, Revenue: l.revenueRaw, 'Year founded': l.founded || '', City: l.city, State: l.state,
        Contact: l.contactName, Title: l.title, Email: l.emailEffective.address || l.emailRaw, 'Email status': l.emailEffective.label,
        Phone: l.phone.display || l.phoneRaw, LinkedIn: l.linkedin, Why: l.why.positives.join('; '), Risks: l.why.risks.join('; '),
        Missing: l.missing.join('; '), 'Duplicates merged': l.duplicates.length,
      }),
    },
    hubspot: {
      label: 'HubSpot import (CSV)',
      filename: 'triage-hubspot.csv',
      headers: ['First Name', 'Last Name', 'Email', 'Phone Number', 'Job Title', 'Company Name', 'Company Domain Name', 'Industry', 'Number of Employees', 'Annual Revenue', 'City', 'State/Region', 'Lead Status', 'Triage Score', 'Triage Tier', 'Triage Notes'],
      row: (l) => ({
        'First Name': l.firstName, 'Last Name': l.lastName,
        Email: l.emailEffective.status === 'valid' ? l.emailEffective.address : '',
        'Phone Number': l.phone.e164 || '', 'Job Title': l.title, 'Company Name': l.company, 'Company Domain Name': l.domain,
        Industry: l.industry, 'Number of Employees': l.employees ? Math.round(l.employees.mid) : '',
        'Annual Revenue': l.revenue ? Math.round(l.revenue.mid) : '', City: l.city, 'State/Region': l.state, 'Lead Status': 'NEW',
        'Triage Score': l.score, 'Triage Tier': l.tier, 'Triage Notes': l.why.positives.concat(l.why.risks).join('; '),
      }),
      filter: (l) => l.queue === 'contact',
    },
    enrich: {
      label: 'Enrichment queue (CSV)',
      filename: 'triage-enrich-queue.csv',
      headers: ['Rank', 'Score', 'Company', 'Website', 'City', 'State', 'Contact', 'Missing'],
      row: (l) => ({ Rank: l.rank, Score: l.score, Company: l.company, Website: l.domain, City: l.city, State: l.state, Contact: l.contactName, Missing: l.missing.filter((m) => m === 'email' || m === 'phone' || m === 'contact name').join('; ') }),
      filter: (l) => l.queue === 'enrich',
    },
  };

  const QUEUE_LABEL = { contact: 'Contact now', enrich: 'Enrich first', hold: 'Hold', skip: 'Skip' };

  function exportCSV(kind, scored) {
    const def = EXPORTS[kind];
    const rows = scored.filter(def.filter || (() => true)).map((l) => def.row(l));
    return { filename: def.filename, csv: toCSV(def.headers, rows), count: rows.length };
  }

  function domainsToCheck(leads) {
    const set = new Set();
    for (const l of leads) {
      if (l.domain) set.add(l.domain);
      if (l.email.status === 'valid' && l.email.domain && !FREE_EMAIL.has(l.email.domain)) set.add(l.email.domain);
    }
    return Array.from(set);
  }

  /** Convenience: full pass from CSV text. */
  function process(text, opts) {
    const { headers, records } = parseCSV(text);
    const mapping = (opts && opts.mapping) || detectColumns(headers);
    const normalized = records.map((r) => normalize(r, mapping, opts));
    const leads = dedupe(normalized);
    return { headers, mapping, rowCount: records.length, leads };
  }

  function clonePreset(mode) {
    return JSON.parse(JSON.stringify(PRESETS[mode]));
  }

  return {
    parseCSV, toCSV, detectColumns, normalize, dedupe, scoreLeads, summarize, renderTemplate, exportCSV, process,
    checkEmail, checkPhone, parseRange, extractDomain, nameKey, classifyTitle, industryGroup, similarity, domainsToCheck,
    clonePreset, money, count, rangeLabel,
    FIELDS, FACTORS, PRESETS, TIERS, QUEUE_LABEL, EXPORTS, INDUSTRY_GROUP_NAMES, SENIORITY_LABEL,
  };
});
