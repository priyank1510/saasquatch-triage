"""Generate data/sample_leads.csv: a synthetic, deliberately messy lead export.

Every company, person, email and phone number here is fictional. The file mimics
what a scraped SaaSquatch export looks like in practice: mixed revenue formats,
headcount ranges, shared inboxes, typos, missing fields and duplicate rows for the
same business (www vs https, LLC vs no suffix, different contacts).

    python scripts/generate_sample.py            # writes data/sample_leads.csv
"""
from __future__ import annotations

import csv
import random
from pathlib import Path

SEED = 7
OUT = Path(__file__).resolve().parent.parent / "data" / "sample_leads.csv"

HEADERS = [
    "Company Name", "Website", "Industry", "Employee Count", "Estimated Revenue",
    "Year Founded", "City", "State", "Country", "Owner Name", "Owner Title",
    "Email", "Phone", "LinkedIn",
]

PREFIXES = [
    "Badger", "Lakeshore", "Summit", "Northstar", "Prairie", "Ironwood", "Bluestem",
    "Cedar", "Granite", "Riverbend", "Keystone", "Harbor", "Maple", "Copper",
    "Oak Ridge", "Pinecrest", "Silverline", "Evergreen", "Redwood", "Frontier",
    "Heartland", "Sterling", "Cobalt", "Juniper", "Beacon", "Tri-County", "Valley",
    "Liberty", "Arrowhead", "Crescent", "Patriot", "Westfield", "Hillcrest",
]

# (industry text as a scraper would return it, company noun, revenue band $M, employee band)
INDUSTRIES = [
    ("HVAC Services", "Heating & Cooling", (1.0, 9.0), (8, 60)),
    ("Plumbing Contractor", "Plumbing", (0.6, 6.0), (5, 40)),
    ("Electrical Contractor", "Electric", (1.0, 12.0), (8, 80)),
    ("Landscaping & Lawn Care", "Landscapes", (0.5, 5.0), (6, 50)),
    ("Pest Control", "Pest Solutions", (0.8, 6.0), (6, 45)),
    ("Commercial Cleaning", "Facility Services", (1.0, 8.0), (20, 150)),
    ("Managed IT Services", "IT Solutions", (1.5, 15.0), (10, 90)),
    ("Bookkeeping & Payroll", "Accounting Group", (0.5, 4.0), (5, 30)),
    ("Staffing Agency", "Staffing", (2.0, 25.0), (10, 70)),
    ("Machine Shop / CNC Machining", "Precision Machining", (2.0, 20.0), (15, 120)),
    ("Metal Fabrication", "Fabrication", (2.0, 18.0), (15, 110)),
    ("Dental Practice", "Family Dental", (0.8, 5.0), (6, 35)),
    ("Veterinary Clinic", "Animal Hospital", (1.0, 6.0), (8, 40)),
    ("Physical Therapy", "Physical Therapy", (0.7, 5.0), (6, 40)),
    ("Freight & Logistics", "Logistics", (3.0, 40.0), (15, 200)),
    ("Insurance Agency", "Insurance Agency", (0.5, 5.0), (4, 30)),
    ("Restaurant", "Grill", (0.4, 3.0), (10, 45)),
    ("Hair Salon", "Salon", (0.1, 0.9), (2, 15)),
    ("Coffee Shop", "Coffee Co", (0.1, 1.2), (3, 20)),
    ("Retail Boutique", "Boutique", (0.2, 1.5), (2, 12)),
    ("Fitness Studio", "Fitness", (0.2, 2.0), (3, 25)),
    ("Software Development", "Software", (0.5, 30.0), (5, 250)),
]

CITIES = [
    ("Milwaukee", "WI"), ("Green Bay", "WI"), ("Columbus", "OH"), ("Indianapolis", "IN"),
    ("Austin", "TX"), ("Dallas", "TX"), ("Phoenix", "AZ"), ("Denver", "CO"),
    ("Charlotte", "NC"), ("Raleigh", "NC"), ("Nashville", "TN"), ("Tampa", "FL"),
    ("Boise", "ID"), ("Omaha", "NE"), ("Kansas City", "MO"), ("Grand Rapids", "MI"),
    ("Sacramento", "CA"), ("Glendale", "CA"), ("Minneapolis", "MN"), ("Des Moines", "IA"),
]

FIRST = ["James", "Maria", "Robert", "Linda", "Michael", "Patricia", "David", "Jennifer",
         "Carlos", "Mei", "Ahmed", "Grace", "Thomas", "Aisha", "Daniel", "Sofia", "Kevin",
         "Priya", "Brian", "Elena", "Mark", "Fatima", "Steven", "Hannah", "Luis", "Nora",
         "Gary", "Denise", "Raymond", "Tanya", "Walter", "Kim"]
LAST = ["Johnson", "Garcia", "Miller", "Nguyen", "Okafor", "Schmidt", "Patel", "Rossi",
        "Kowalski", "Hernandez", "Chen", "Anderson", "Murphy", "Novak", "Larson", "Brooks",
        "Fischer", "Reyes", "Olsen", "Bennett", "Haddad", "Yamamoto", "Sullivan", "Price"]

TITLES = [
    ("Owner", 26), ("Founder & CEO", 8), ("President", 12), ("Co-Owner", 6),
    ("General Manager", 8), ("Office Manager", 9), ("Operations Director", 5),
    ("VP of Sales", 4), ("Marketing Coordinator", 4), ("", 10),
]

SUFFIXES = [" LLC", " Inc.", " Co.", "", "", " Group"]


def weighted(rng: random.Random, items):
    total = sum(w for _, w in items)
    r = rng.uniform(0, total)
    for v, w in items:
        r -= w
        if r <= 0:
            return v
    return items[-1][0]


def fmt_revenue(rng: random.Random, millions: float) -> str:
    style = rng.choice(["m", "m", "full", "range", "range_short", "k", "blank"])
    if style == "blank":
        return ""
    if style == "m":
        return f"${millions:.1f}M"
    if style == "full":
        return f"{int(millions * 1_000_000):,}"
    if style == "range":
        lo = max(1, int(millions))
        return f"${lo}M - ${lo * 2 if lo < 5 else lo + 5}M"
    if style == "range_short":
        lo = max(1, int(millions))
        return f"{lo}-{lo + 4}M"
    return f"${int(millions * 1000)}K"


def fmt_employees(rng: random.Random, n: int) -> str:
    style = rng.choice(["exact", "range", "range", "blank"])
    if style == "blank":
        return ""
    if style == "exact":
        return str(n)
    for lo, hi in [(1, 10), (11, 50), (51, 200), (201, 500)]:
        if n <= hi:
            return f"{lo}-{hi}"
    return "500+"


def phone(rng: random.Random) -> str:
    area = rng.randint(201, 989)
    while area % 100 == 11:
        area += 1
    ex = rng.randint(200, 989)
    line = rng.randint(1000, 9999)
    return rng.choice([f"({area}) {ex}-{line}", f"{area}-{ex}-{line}", f"+1 {area} {ex} {line}", f"{area}.{ex}.{line}"])


def slug(s: str) -> str:
    return "".join(ch for ch in s.lower() if ch.isalnum())


def build_rows(rng: random.Random):
    rows = []
    used = set()
    while len(rows) < 140:
        prefix = rng.choice(PREFIXES)
        industry, noun, (rlo, rhi), (elo, ehi) = rng.choice(INDUSTRIES)
        name = f"{prefix} {noun}"
        if name in used:
            continue
        used.add(name)
        company = name + rng.choice(SUFFIXES)
        city, state = rng.choice(CITIES)
        domain = slug(prefix) + slug(noun.split()[0]) + rng.choice([".com", ".com", ".com", ".net", ".co"])
        revenue = rng.uniform(rlo, rhi) * rng.choice([1, 1, 0.3, 0.5, 2.5, 4])
        employees = max(1, int(rng.uniform(elo, ehi) * rng.choice([1, 1, 0.4, 2.5])))
        founded = rng.choice([rng.randint(1968, 2000), rng.randint(1990, 2015), rng.randint(2012, 2023), ""])
        first, last = rng.choice(FIRST), rng.choice(LAST)
        title = weighted(rng, TITLES)
        # ~45% of a scraped export has not been enriched yet: company-level data only
        has_contact = rng.random() > 0.45
        email_style = weighted(rng, [("first", 30), ("first.last", 20), ("role", 16), ("gmail", 10),
                                     ("blank", 14), ("typo", 4), ("disposable", 2), ("nodomain", 4)])
        if not has_contact:
            email_style = weighted(rng, [("role", 35), ("blank", 65)])
        email = {
            "first": f"{first.lower()}@{domain}",
            "first.last": f"{first.lower()}.{last.lower()}@{domain}",
            "role": f"{rng.choice(['info', 'office', 'sales', 'contact', 'hello'])}@{domain}",
            "gmail": f"{first.lower()}{last.lower()}{rng.randint(1, 99)}@gmail.com",
            "blank": "",
            "typo": f"{first.lower()}@@{domain}",
            "disposable": f"{first.lower()}@mailinator.com",
            "nodomain": f"{first.lower()}.{last.lower()}@{domain.split('.')[0]}",
        }[email_style]
        ph = weighted(rng, [("ok", 70), ("blank", 20), ("junk", 6), ("short", 4)] if has_contact else [("ok", 55), ("blank", 45)])
        ph = {"ok": phone(rng), "blank": "", "junk": "000-000-0000", "short": f"{rng.randint(100, 999)}-{rng.randint(1000, 9999)}"}[ph]
        website = rng.choice([f"https://www.{domain}", f"http://{domain}/", f"www.{domain}", domain, f"https://{domain}", ""])
        if website == "" and rng.random() < 0.5:
            website = ""
        rows.append({
            "Company Name": company,
            "Website": website,
            "Industry": industry,
            "Employee Count": fmt_employees(rng, employees),
            "Estimated Revenue": fmt_revenue(rng, revenue),
            "Year Founded": str(founded),
            "City": city,
            "State": state,
            "Country": "United States",
            "Owner Name": f"{first} {last}" if has_contact else "",
            "Owner Title": title if has_contact else "",
            "Email": email,
            "Phone": ph,
            "LinkedIn": f"https://www.linkedin.com/in/{first.lower()}-{last.lower()}-{rng.randint(100, 999)}" if has_contact and rng.random() < 0.35 else "",
            "_domain": domain,
        })
    return rows


def make_duplicates(rng: random.Random, rows):
    """Re-scrapes of the same business: different URL format, suffix, casing or contact."""
    dupes = []
    for src in rng.sample(rows, 18):
        d = dict(src)
        variant = rng.choice(["url", "suffix", "case", "contact", "sparse"])
        if variant == "url":
            d["Website"] = f"https://www.{src['_domain']}/contact-us"
        elif variant == "suffix":
            base = src["Company Name"]
            for suf in (" LLC", " Inc.", " Co.", " Group"):
                base = base.replace(suf, "")
            d["Company Name"] = base + rng.choice([", LLC", " Incorporated", " Company"])
            d["Website"] = ""
        elif variant == "case":
            d["Company Name"] = src["Company Name"].upper()
            d["City"] = src["City"].upper()
        elif variant == "contact":
            f, l = rng.choice(FIRST), rng.choice(LAST)
            d["Owner Name"], d["Owner Title"] = f"{f} {l}", rng.choice(["Owner", "Office Manager", "President"])
            d["Email"] = f"{f.lower()}@{src['_domain']}"
        else:
            for k in ("Estimated Revenue", "Employee Count", "Phone", "Email"):
                d[k] = ""
        dupes.append(d)
    return dupes


def main():
    rng = random.Random(SEED)
    rows = build_rows(rng)
    rows += make_duplicates(rng, rows)
    rng.shuffle(rows)
    rows.insert(rng.randint(10, 100), {h: "" for h in HEADERS})  # blank line from a bad export
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=HEADERS, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)
    print(f"wrote {len(rows)} rows to {OUT}")


if __name__ == "__main__":
    main()
