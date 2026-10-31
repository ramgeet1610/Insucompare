"""Convert OPM 2027 Public Use Files -> the JSON data files InsuCompare loads.

Key structural change from the 2026 dataset: an OPM "Plan Code" (e.g. EP) is a
carrier CONTRACT and can carry several plan OPTIONS (EP = "Aetna HealthFund CDHP"
and "Value Plan"), which have different premiums. 2026 happened to have one option
per code; 2027 has 118 options across 82 codes. So each option needs its own
identifier or two different plans would share one premium.

  plan_code       - unique per OPTION: the option's Self enrollment code (e.g. EP1).
                    Verified unique across all 118 options.
  opm_plan_code   - the OPM plan code (EP). Service-area eligibility is published at
                    this level, so eligibility and formulary lookups use it.
  enrollment_codes- {enrollment type -> the code you actually give your HR office}.
"""
import json, os, re, sys, collections
from openpyxl import load_workbook

RAW, OUT, OLD = sys.argv[1], sys.argv[2], sys.argv[3]
F = lambda n: os.path.join(RAW, n)

def load(fn, sheet=None):
    wb = load_workbook(F(fn), read_only=True, data_only=True)
    ws = wb[sheet] if sheet else wb[wb.sheetnames[0]]
    rows = list(ws.iter_rows(values_only=True)); wb.close()
    return rows

def table(rows, hdr_row=0):
    hdr = rows[hdr_row]
    idx = {h: i for i, h in enumerate(hdr) if h is not None}
    return idx, rows[hdr_row + 1:]

def s(v):
    if v is None: return None
    v = str(v).strip()
    return v or None

def money(v):
    """'$1,000' -> 1000.0 ; 'Not applicable'/blank -> None"""
    if v is None: return None
    t = str(v).strip()
    if not t or t.lower() in ('not applicable', 'n/a', 'na', 'none', '-'): return None
    m = re.search(r'-?[\d,]+(?:\.\d+)?', t.replace('$', ''))
    if not m: return None
    try: return float(m.group(0).replace(',', ''))
    except ValueError: return None

report = []
def note(m):
    report.append(m); print(m)

# ===================== MEDICAL =====================
pk_idx, pk_rows = table(load('2027-fehb-plan-key_10152026.xlsx'))
pk_rows = [r for r in pk_rows if s(r[pk_idx['Plan Code']])]

# option key = (plan code, option name)
options = {}
for r in pk_rows:
    code = s(r[pk_idx['Plan Code']])
    opt = s(r[pk_idx['Plan Option Name']])
    etype = s(r[pk_idx['Enrollment Type']])
    ecode = s(r[pk_idx['Enrollment Code']])
    k = (code, opt)
    o = options.setdefault(k, {
        'opm_plan_code': code,
        'plan_option_name': opt,
        'carrier_name': s(r[pk_idx['Carrier Name']]),
        'network_type': s(r[pk_idx['Network Type']]),
        'plan_option_type': s(r[pk_idx['Plan Option Type']]),
        'formulary_ids': s(r[pk_idx['Drug List IDs']]),
        'brochure_number': s(r[pk_idx['Brochure Number']]),
        'phone_number': s(r[pk_idx['Phone Number']]),
        'carrier_url': s(r[pk_idx['Carrier URL']]),
        'provider_directory_url': s(r[pk_idx['Provider Directory URL']]),
        'plan_formulary_url': s(r[pk_idx['Plan Formulary URL']]),
        'enrollment_codes': {},
    })
    o['enrollment_codes'][etype] = ecode
note(f'plan key: {len(options)} plan options across '
     f'{len({c for c, _ in options})} OPM plan codes')

# unique id = Self enrollment code
for k, o in options.items():
    o['plan_code'] = o['enrollment_codes'].get('Self') or o['enrollment_codes'].get('Self Only')
missing = [k for k, o in options.items() if not o['plan_code']]
assert not missing, f'options with no Self enrollment code: {missing}'
assert len({o['plan_code'] for o in options.values()}) == len(options), 'plan_code not unique'

# ---- benefits (in-network row) ----
bn_idx, bn_rows = table(load('2027-fehb-plan-benefits_10212026.xlsx'))
BEN = {
    'deductible_self': 'Annual deductible (Self)',
    'deductible_self_plus_one': 'Annual deductible (Self Plus One)',
    'deductible_family': 'Annual deductible (Self & Family)',
    'oop_max_self': 'Annual out-of-pocket maximum (Self)',
    'oop_max_self_plus_one': 'Annual out-of-pocket maximum (Self Plus One)',
    'oop_max_family': 'Annual out-of-pocket maximum (Self & Family)',
}
RAWCOLS = {
    'pcp_visit_cost': 'Primary Care Office Visit',
    'specialist_visit_cost': 'Specialist Office Visit',
    'er_cost': 'Emergency Care',
    'urgent_care_cost': 'Urgent Care',
    'preventive_care': 'Preventive Care',
    'Mail Order Pharmacy': 'Mail Order Pharmacy',
}
matched = 0
for r in bn_rows:
    if s(r[bn_idx['In-network/out-of-network']]) != 'In-network': continue
    k = (s(r[bn_idx['Plan Code']]), s(r[bn_idx['Plan Option Name']]))
    o = options.get(k)
    if o is None: continue
    matched += 1
    for dest, col in BEN.items():
        o[dest] = money(r[bn_idx[col]])
    for dest, col in RAWCOLS.items():
        o[dest] = s(r[bn_idx[col]])
    for t in range(7):
        o[f'Tier {t}'] = s(r[bn_idx[f'Tier {t}']])
    o['hsa_hra_type'] = s(r[bn_idx['Type of account']])
    o['hsa_hra_self'] = money(r[bn_idx['Medical account contribution (Self)']])
    o['hsa_hra_self_plus_one'] = money(r[bn_idx['Medical account contribution (Self Plus One)']])
    o['hsa_hra_family'] = money(r[bn_idx['Medical account contribution (Self & Family)']])
note(f'benefits: matched in-network rows for {matched}/{len(options)} options')
assert matched == len(options), 'some options have no in-network benefit row'

# ---- rates (non-postal active, biweekly) ----
rt_idx, rt_rows = table(load('2027-fehb-rates_092926.xlsx'))
by_opt = {(o['opm_plan_code'], o['plan_option_name']): o for o in options.values()}
rates = []
seen = set()
for r in rt_rows:
    if s(r[rt_idx['Rate Type']]) != 'NP Active': continue
    if s(r[rt_idx['Biweekly/Monthly']]) != 'Biweekly': continue
    code = s(r[rt_idx['Plan Code']]); opt = s(r[rt_idx['Plan Code Option Type']])
    o = by_opt.get((code, opt))
    if o is None:
        note(f'  WARN rate row with no matching option: {code} / {opt}'); continue
    etype = s(r[rt_idx['Enrollment Type']])
    emp = money(r[rt_idx['Employee Pays']]); gov = money(r[rt_idx['Government Pays']])
    if emp is None: continue
    rates.append({
        'plan_code': o['plan_code'],
        'enrollment_type': etype,
        'employee_pays': round(emp, 2),
        'government_pays': round(gov, 2) if gov is not None else None,
        'total_biweekly_premium': round(emp + (gov or 0), 2),
        'annual_premium_employee': round(emp * 26, 2),
    })
    seen.add((o['plan_code'], etype))
note(f'rates: {len(rates)} rows ({len(rates)//3} options x 3 enrollment types)')
need = {(o['plan_code'], e) for o in options.values()
        for e in ('Self', 'Self Plus One', 'Self & Family')}
assert not (need - seen), f'missing rate rows: {sorted(need - seen)[:5]}'

# ---- service area ----
sa_idx, sa_rows = table(load('2027-fehb-service-area_10092026.xlsx'))
nationwide, state_to, fips_to = set(), collections.defaultdict(set), collections.defaultdict(set)
for r in sa_rows:
    code = s(r[sa_idx['Plan Code']])
    if not code: continue
    if s(r[sa_idx['Nationwide (Y/N)']]) == 'Y':
        nationwide.add(code); continue
    st = s(r[sa_idx['State code']])
    if s(r[sa_idx['Statewide (Y/N)']]) == 'Y' and st:
        state_to[st].add(code); continue
    fips = r[sa_idx['County FIPS']]
    if fips not in (None, '', 'None'):
        fips_to[str(int(fips)).zfill(5)].add(code)
    elif st:
        state_to[st].add(code)
note(f'service area: {len(nationwide)} nationwide codes, {len(state_to)} states, '
     f'{len(fips_to)} counties')

plans_out = []
for o in sorted(options.values(), key=lambda x: (x['carrier_name'] or '', x['plan_option_name'] or '')):
    o.pop('__', None); plans_out.append(o)

# ===================== FEDVIP =====================
def fedvip_key(sheet):
    idx, rows = table(load('2027-fedvip-plan-key_092926.xlsx', sheet))
    rows = [r for r in rows if s(r[idx['Plan Code Name']])]
    return idx, rows

def fedvip_benefits(sheet, network):
    idx, rows = table(load('2027-fedvip-benefits_092926.xlsx', sheet))
    out = {}
    for r in rows:
        if s(r[idx['Network Type']]) != network: continue
        out[(s(r[idx['Plan Code Name']]), s(r[idx['Plan Code Option Type']]))] = (idx, r)
    return out

# --- dental plans ---
di, drows = fedvip_key('Dental Plans')
d_in = fedvip_benefits('Dental Benefits', 'In-Network 1')
d_out = fedvip_benefits('Dental Benefits', 'Out-of-Network')
dental = {}
for r in drows:
    carrier = s(r[di['Plan Code Name']]); opt = s(r[di['Plan Code Option Type']])
    k = (carrier, opt)
    d = dental.setdefault(k, {
        'carrier_name': carrier, 'plan_option': opt,
        'brochure_number': s(r[di['Brochure Number']]),
        'phone_number': s(r[di['Phone Number']]),
        'website': s(r[di['Contract Website']]),
        'provider_directory_url': s(r[di['Contract Provider Directory']]),
        '_areas': set(),
    })
    d['_areas'].add(s(r[di['Service Area']]))
for k, d in dental.items():
    areas = sorted(a for a in d.pop('_areas') if a)
    d['is_nationwide'] = any(a.lower() == 'nationwide' for a in areas)
    d['service_area_raw'] = 'Nationwide' if d['is_nationwide'] else ', '.join(areas)
    d['Contract Type'] = 'Dental'
    bi = d_in.get(k); bo = d_out.get(k)
    if bi:
        i, row = bi
        d['preventive'] = s(row[i['Class A - Preventive']])
        d['intermediate'] = s(row[i['Class B - Intermediate']])
        d['major'] = s(row[i['Class C - Major']])
        d['orthodontic'] = s(row[i['Class D - Orthodontic']])
        d['ortho_lifetime_max_raw'] = s(row[i['Class D - Orthodontic Lifetime Maximum']])
        d['deductible'] = money(row[i['Per Person Deductible']]) or 0.0
        amb = s(row[i['Annual Maximum Benefit Per Person']])
        d['annual_max_unlimited'] = bool(amb and amb.upper().startswith('UNLIMIT'))
        d['annual_max'] = None if d['annual_max_unlimited'] else money(amb)
    if bo:
        i, row = bo
        d['out_preventive'] = s(row[i['Class A - Preventive']])
        d['out_intermediate'] = s(row[i['Class B - Intermediate']])
        d['out_major'] = s(row[i['Class C - Major']])
        d['out_orthodontic'] = s(row[i['Class D - Orthodontic']])
note(f'dental: {len(dental)} plan options, {len({c for c,_ in dental})} carriers')

# --- vision plans ---
vi, vrows = fedvip_key('Vision Plans')
v_in = fedvip_benefits('Vision Benefits', 'In-Network 1')
v_out = fedvip_benefits('Vision Benefits', 'Out-of-Network')
vision = {}
for r in vrows:
    carrier = s(r[vi['Plan Code Name']]); opt = s(r[vi['Plan Code Option Type']])
    k = (carrier, opt)
    if k in vision: continue
    v = {
        'carrier_name': carrier, 'plan_option': opt,
        'brochure_number': s(r[vi['Brochure Number']]),
        'phone_number': s(r[vi['Phone Number']]),
        'website': s(r[vi['Contract Website']]),
        'provider_directory_url': s(r[vi['Contract Provider Directory']]),
        'Contract Type': 'Vision',
    }
    bi = v_in.get(k); bo = v_out.get(k)
    if bi:
        i, row = bi
        v['exam_coverage'] = s(row[i['Vision - Vision Exam']])
        v['lenses_coverage'] = s(row[i['Vision - Vision Lenses Only']])
        v['frames_coverage'] = s(row[i['Vision - Frames']])
        v['copay_summary'] = s(row[i['Vision - Copay']])
        v['additional_features'] = s(row[i['Vision - Additional Features']])
    if bo:
        i, row = bo
        v['out_exam_coverage'] = s(row[i['Vision - Vision Exam']])
        v['out_lenses_coverage'] = s(row[i['Vision - Vision Lenses Only']])
        v['out_frames_coverage'] = s(row[i['Vision - Frames']])
        v['out_copay_summary'] = s(row[i['Vision - Copay']])
    vision[k] = v
note(f'vision: {len(vision)} plan options, {len({c for c,_ in vision})} carriers')

# --- FEDVIP rates (header is row index 2; data starts after a note row) ---
def fedvip_rates(sheet, has_region):
    rows = load('2027-fedvip-rates_092926.xlsx', sheet)
    hdr_i = next(i for i, r in enumerate(rows)
                 if r and s(r[0]) and s(r[0]).lower().startswith('plan - option'))
    out = []
    for r in rows[hdr_i + 1:]:
        name = s(r[0])
        if not name or ' - ' not in name: continue
        carrier, opt = name.rsplit(' - ', 1)
        rec = {'carrier_name': carrier.strip(), 'plan_option': opt.strip()}
        if has_region:
            rec['rating_region'] = s(r[1]) or '0'
            cols = (2, 3, 4, 5, 6, 7)
        else:
            cols = (2, 3, 4, 5, 6, 7)
        keys = ('biweekly_self', 'biweekly_self_plus_one', 'biweekly_family',
                'monthly_self', 'monthly_self_plus_one', 'monthly_family')
        for kk, c in zip(keys, cols):
            rec[kk] = money(r[c]) if c < len(r) else None
        out.append(rec)
    return out

dental_rates = fedvip_rates('Dental', True)
vision_rates = fedvip_rates('Vision', False)
note(f'dental rates: {len(dental_rates)} rows | vision rates: {len(vision_rates)} rows')

for v in vision.values():
    m = next((x for x in vision_rates
              if x['carrier_name'] == v['carrier_name'] and x['plan_option'] == v['plan_option']), None)
    if m is None:
        note(f"  WARN no vision rate for {v['carrier_name']} / {v['plan_option']}")
        continue
    for kk in ('biweekly_self', 'biweekly_self_plus_one', 'biweekly_family',
               'monthly_self', 'monthly_self_plus_one', 'monthly_family'):
        v[kk] = m[kk]

# --- dental ZIP -> region ---
dental_carriers = sorted({c for c, _ in dental})
carrier_codes = {c: f'c{i}' for i, c in enumerate(dental_carriers)}
pos = {c: i for i, c in enumerate(dental_carriers)}
wb = load_workbook(F('2027-fedvip-zipcodes_092926.xlsx'), read_only=True, data_only=True)
ws = wb[wb.sheetnames[0]]
it = ws.iter_rows(values_only=True)
zh = next(it); zi = {h: i for i, h in enumerate(zh)}
zipmap = collections.defaultdict(lambda: [''] * len(dental_carriers))
unknown = collections.Counter()
for r in it:
    nm = s(r[zi['Plan Name']])
    if nm not in pos:
        unknown[nm] += 1; continue
    z = str(r[zi['ZIP Code']]).strip().zfill(5)
    zipmap[z][pos[nm]] = str(s(r[zi['Region']]) or '')
wb.close()
dental_zip_region = {z: ','.join(v) for z, v in zipmap.items()}
note(f'dental zip regions: {len(dental_zip_region):,} ZIPs x {len(dental_carriers)} carriers')
note(f'  non-dental plan names skipped (vision): {len(unknown)}')

# ===================== WRITE =====================
def w(name, obj):
    p = os.path.join(OUT, name)
    with open(p, 'w') as f: json.dump(obj, f, separators=(',', ':'))
    note(f'  wrote {name:<34} {os.path.getsize(p)/1024:>8.0f}KB')

note('\nwriting:')
w('medical_plans.json', plans_out)
w('medical_rates.json', rates)
w('medical_nationwide_codes.json', sorted(nationwide))
w('medical_state_to_plans.json', {k: sorted(v) for k, v in sorted(state_to.items())})
w('medical_fips_to_plans.json', {k: sorted(v) for k, v in sorted(fips_to.items())})
w('dental_plans.json', [dental[k] for k in sorted(dental)])
w('dental_rates.json', dental_rates)
w('vision_plans.json', [vision[k] for k in sorted(vision)])
w('dental_carrier_codes.json', carrier_codes)
w('dental_zip_region.json', dental_zip_region)

with open(os.path.join(OUT, '_conversion_report.txt'), 'w') as f:
    f.write('\n'.join(report))
