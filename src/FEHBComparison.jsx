import React, { useState } from 'react';

const USAGE_PROFILES = {
  minimal: {
    pcp: 1, specialist: 0, er: 0, urgent: 0,
    label: 'Just an annual checkup',
    detail: 'You\'re generally healthy and mostly want coverage in case something unexpected happens.',
  },
  routine: {
    pcp: 2, specialist: 1, er: 0, urgent: 1,
    label: 'Routine care, nothing major',
    detail: 'A checkup, maybe one specialist visit, an occasional urgent care trip.',
  },
  family: {
    pcp: 5, specialist: 2, er: 1, urgent: 2,
    label: 'Family with young kids',
    detail: 'Pediatric checkups and vaccines, occasional sick visits and urgent care, the usual bumps and colds.',
  },
  chronic: {
    pcp: 4, specialist: 8, er: 0, urgent: 1,
    label: 'Managing an ongoing condition',
    detail: 'Regular specialist follow-ups throughout the year. If you take regular medications, add them below for a more complete estimate.',
  },
  intensive: {
    pcp: 6, specialist: 10, er: 2, urgent: 3,
    label: 'Significant medical needs',
    detail: 'Frequent specialist care, possible hospital visits — a year where you expect to use your plan heavily.',
  },
};

const ENROLLMENT_TYPES = ['Self Only', 'Self Plus One', 'Self and Family'];
const ENROLLMENT_TO_RATE_LABEL = { 'Self Only': 'Self', 'Self Plus One': 'Self Plus One', 'Self and Family': 'Self & Family' };
const ENROLLMENT_DEDUCTIBLE_FIELD = { 'Self Only': 'deductible_self', 'Self Plus One': 'deductible_self_plus_one', 'Self and Family': 'deductible_family' };
const ENROLLMENT_OOPMAX_FIELD = { 'Self Only': 'oop_max_self', 'Self Plus One': 'oop_max_self_plus_one', 'Self and Family': 'oop_max_family' };

function parseCostShare(str, assumedAllowedAmount) {
  if (str == null) return null;
  const s = String(str).trim();
  if (s.toLowerCase().includes('not applicable')) return null;
  if (s.toLowerCase().includes('member pays nothing')) return 0;
  const coinsMatch = s.match(/(\d+(?:\.\d+)?)\s*%\s*Coinsurance/i);
  if (coinsMatch) return (parseFloat(coinsMatch[1]) / 100) * assumedAllowedAmount;
  const dollarMatch = s.match(/\$\s*([\d,]+(?:\.\d+)?)/);
  if (dollarMatch) return parseFloat(dollarMatch[1].replace(/,/g, ''));
  // Bare number with no $ or % (e.g. UHC plan L9 stores "50" instead of "$50") -
  // only treat as a dollar copay if the ENTIRE string is just a number, to avoid
  // misinterpreting other unanticipated text formats as a dollar amount.
  const bareNumberMatch = s.match(/^([\d,]+(?:\.\d+)?)$/);
  if (bareNumberMatch) return parseFloat(bareNumberMatch[1].replace(/,/g, ''));
  return null;
}

function getDrugTier(drugName, planCode, formulary) {
  const key = drugName.trim().toLowerCase();
  if (!(key in formulary)) return { found: false, planMapped: false, tier: null, covered: null };
  const planMap = formulary[key];
  if (!(planCode in planMap)) return { found: true, planMapped: false, tier: null, covered: null };
  const tier = planMap[planCode];
  return { found: true, planMapped: true, tier, covered: tier !== null };
}

function estimateDrugCost(planRow, drugNames, formulary, fillsPerYear = 12) {
  const breakdown = [];
  let total = 0;
  let anyUnknown = false;
  const planCode = String(planRow.opm_plan_code);

  for (const drug of drugNames) {
    const lookup = getDrugTier(drug, planCode, formulary);
    if (!lookup.found || !lookup.planMapped) {
      breakdown.push({ drug, status: 'no_formulary_data_for_this_plan', annualCost: null });
      anyUnknown = true;
      continue;
    }
    if (!lookup.covered) {
      breakdown.push({ drug, status: 'not_covered_on_this_plan', annualCost: null });
      continue;
    }
    const tierCostStr = planRow[`Tier ${lookup.tier}`];
    const perFillCost = parseCostShare(tierCostStr, 300);
    if (perFillCost == null) {
      breakdown.push({ drug, status: 'tier_cost_unparseable', tier: lookup.tier, annualCost: null });
      anyUnknown = true;
      continue;
    }
    const annual = perFillCost * fillsPerYear;
    total += annual;
    breakdown.push({ drug, status: 'estimated', tier: lookup.tier, perFillCost, annualCost: annual });
  }

  return { breakdown, totalAnnualDrugCost: total, hasUnknown: anyUnknown };
}

function resolveEligiblePlans(zipCode, data) {
  const nationwide = new Set(data.nationwideCodes);
  const info = data.zipInfo[zipCode];
  if (!info) return { codes: nationwide, state: null };
  const [fips, state] = info.split('|');
  const countyPlans = data.fipsToPlans[fips] || [];
  const statewidePlans = data.stateToPlans[state] || [];
  return { codes: new Set([...nationwide, ...countyPlans, ...statewidePlans]), state };
}

function estimateVisitCosts(planRow, usageProfile, assumedAllowedAmount = 150) {
  const costFor = (str, count) => {
    const c = parseCostShare(str, assumedAllowedAmount);
    return c == null ? 0 : c * count;
  };
  return (
    costFor(planRow.pcp_visit_cost, usageProfile.pcp) +
    costFor(planRow.specialist_visit_cost, usageProfile.specialist) +
    costFor(planRow.er_cost, usageProfile.er) +
    costFor(planRow.urgent_care_cost, usageProfile.urgent)
  );
}

function comparePlans({ zipCode, enrollmentType, usageKey, drugs }, data) {
  const usageProfile = USAGE_PROFILES[usageKey];
  const { codes: eligibleCodes } = resolveEligiblePlans(zipCode, data);
  // Eligibility is published per OPM plan code (a carrier contract), which can carry
  // several plan options. Each option keeps its own unique plan_code for rates.
  const eligiblePlans = data.plans.filter(p => eligibleCodes.has(p.opm_plan_code));
  const rateLabel = ENROLLMENT_TO_RATE_LABEL[enrollmentType];
  const nationwideSet = new Set(data.nationwideCodes);

  const results = eligiblePlans.map(plan => {
    const rateRow = data.rates.find(r => r.plan_code === plan.plan_code && r.enrollment_type === rateLabel);
    const annualPremium = rateRow ? rateRow.annual_premium_employee : null;
    const visitCosts = estimateVisitCosts(plan, usageProfile);

    let drugResult = { totalAnnualDrugCost: 0, hasUnknown: false, breakdown: [] };
    if (drugs && drugs.length > 0) {
      drugResult = estimateDrugCost(plan, drugs, data.formulary);
    }

    const baseCost = (annualPremium || 0) + visitCosts;
    const grandTotal = baseCost + drugResult.totalAnnualDrugCost;
    const isNationwide = nationwideSet.has(plan.opm_plan_code);
    const networkBreadth = classifyNetworkBreadth(plan, isNationwide);

    return {
      planCode: plan.plan_code,
      opmPlanCode: plan.opm_plan_code,
      enrollmentCode: (plan.enrollment_codes || {})[rateLabel] || plan.opm_plan_code,
      carrierName: plan.carrier_name,
      planOptionName: plan.plan_option_name,
      networkType: plan.network_type,
      networkBreadth,
      formularyUrl: plan.plan_formulary_url,
      annualPremium,
      visitCosts,
      deductible: plan[ENROLLMENT_DEDUCTIBLE_FIELD[enrollmentType]],
      oopMax: plan[ENROLLMENT_OOPMAX_FIELD[enrollmentType]],
      drugCost: drugResult.totalAnnualDrugCost,
      hasUnknownDrugCosts: drugResult.hasUnknown,
      drugBreakdown: drugResult.breakdown,
      grandTotal,
    };
  });

  results.sort((a, b) => a.grandTotal - b.grandTotal);
  return results;
}

function classifyNetworkBreadth(plan, isNationwide) {
  const networkType = (plan.network_type || '').toUpperCase();
  if (networkType.includes('HMO')) {
    return {
      label: 'Local network (HMO)',
      detail: "This plan generally only covers care from its own network in your area. If you travel or move, you may have limited or no coverage outside this plan's service area except for emergencies.",
      level: 'restrictive',
    };
  }
  if (isNationwide) {
    return {
      label: 'Nationwide network',
      detail: 'This plan has a nationwide network — generally a safer choice if you travel often, have providers in multiple states, or might relocate.',
      level: 'broad',
    };
  }
  return {
    label: 'Regional network',
    detail: "This plan's network is regional rather than nationwide. Check the plan's provider directory if you split time between states or might move.",
    level: 'moderate',
  };
}

function planSummary(plan, enrollmentType) {
  const parts = [];
  const networkType = (plan.network_type || '').toUpperCase();

  if (networkType.includes('HMO')) {
    parts.push("This is an HMO — you'll generally need to use the plan's network and may need referrals to see specialists.");
  } else if (networkType.includes('HDHP')) {
    parts.push("This is a high-deductible plan — lower premiums, but you pay more out of pocket before coverage kicks in.");
  } else if (networkType.includes('PPO') || networkType.includes('FFS')) {
    parts.push("This is a PPO/fee-for-service plan — more flexibility to see providers outside the network, usually at a higher cost.");
  }

  const deductible = plan[ENROLLMENT_DEDUCTIBLE_FIELD[enrollmentType]];
  if (deductible === 0) {
    parts.push('No annual deductible — coverage starts from your first visit.');
  } else if (deductible != null) {
    parts.push(`You'll pay the first ${fmt(deductible)} of care yourself each year before this plan's coverage fully kicks in.`);
  }

  return parts.join(' ');
}

// ===== DENTAL (FEDVIP) LOGIC =====

const DENTAL_ENROLLMENT_FIELD = {
  'Self Only': 'self',
  'Self Plus One': 'self_plus_one',
  'Self and Family': 'family',
};

function parseCoinsurance(str) {
  // "0% Coinsurance" -> 0 ; "60% Coinsurance" -> 0.6 ; null/undefined -> null
  if (str == null) return null;
  const m = String(str).match(/(\d+(?:\.\d+)?)\s*%/);
  return m ? parseFloat(m[1]) / 100 : null;
}

function dentalEligiblePlans(zipCode, dentalData) {
  // NOTE: eligibility is determined by presence in the per-ZIP rating-region data,
  // not by the Plan Key file's "Service Area" field. These two OPM source files
  // disagree for at least one carrier: Humana Dental's Plan Key lists "Alabama" as
  // its service area, but its actual ZIP-to-region pricing data covers 27 states.
  // The ZIP-region file is the operative one (it's what actually prices a plan for
  // a given ZIP), so it's treated as the source of truth for eligibility here.
  const codes = dentalData.carrierCodes; // { "Aetna Dental": "c0", ... }
  const codeToCarrier = Object.fromEntries(Object.entries(codes).map(([k, v]) => [v, k]));
  const regionStr = dentalData.zipRegion[zipCode];
  const eligible = {}; // carrierName -> region string
  if (!regionStr) return eligible; // unknown zip - no dental eligibility data, handled by caller
  const regions = regionStr.split(',');
  for (let i = 0; i < regions.length; i++) {
    const carrierName = codeToCarrier[`c${i}`];
    if (carrierName && regions[i] !== '') {
      eligible[carrierName] = regions[i];
    }
  }
  return eligible;
}

function compareDentalPlans({ zipCode, enrollmentType, usageLevel }, dentalData) {
  const eligible = dentalEligiblePlans(zipCode, dentalData);
  const enrollField = DENTAL_ENROLLMENT_FIELD[enrollmentType];

  // Rough usage-based estimate of out-of-pocket beyond premium: a simple 3-tier
  // model (preventive-only / some basic-restorative work / major work expected)
  // analogous to the medical usage profiles, applied to coinsurance percentages.
  const usageAssumedCost = { low: 0, medium: 300, high: 1500 }[usageLevel] || 300;
  const usageCategory = { low: 'preventive', medium: 'intermediate', high: 'major' }[usageLevel] || 'intermediate';

  const results = [];
  for (const plan of dentalData.plans) {
    if (!(plan.carrier_name in eligible)) continue;
    const region = eligible[plan.carrier_name];
    const rateRow = dentalData.rates.find(r =>
      r.carrier_name === plan.carrier_name && r.plan_option === plan.plan_option && r.rating_region === region);
    if (!rateRow) continue;

    const biweeklyPremium = rateRow[`biweekly_${enrollField}`];
    const annualPremium = biweeklyPremium != null ? biweeklyPremium * 26 : null;

    const coinsRate = parseCoinsurance(plan[usageCategory]);
    const estimatedOutOfPocket = coinsRate != null ? coinsRate * usageAssumedCost : 0;
    const deductible = plan.deductible || 0;

    results.push({
      carrierName: plan.carrier_name,
      planOption: plan.plan_option,
      isNationwide: plan.is_nationwide,
      website: plan.website,
      providerDirectoryUrl: plan.provider_directory_url,
      annualPremium,
      deductible,
      annualMax: plan.annual_max,
      annualMaxUnlimited: plan.annual_max_unlimited,
      preventiveCoverage: plan.preventive,
      majorCoverage: plan.major,
      orthoCoverage: plan.orthodontic,
      estimatedOutOfPocket,
      grandTotal: (annualPremium || 0) + estimatedOutOfPocket,
    });
  }

  results.sort((a, b) => a.grandTotal - b.grandTotal);
  return results;
}

// ===== VISION (FEDVIP) LOGIC =====
// Simpler than dental: all 5 vision carriers are nationwide with flat (non-regional)
// rates, so no ZIP eligibility lookup is needed - just enrollment type -> premium.

function compareVisionPlans({ enrollmentType }, visionPlans) {
  const enrollField = DENTAL_ENROLLMENT_FIELD[enrollmentType];
  return visionPlans
    .map(plan => ({
      carrierName: plan.carrier_name,
      planOption: plan.plan_option,
      website: plan.website,
      providerDirectoryUrl: plan.provider_directory_url,
      annualPremium: plan[`biweekly_${enrollField}`] != null ? plan[`biweekly_${enrollField}`] * 26 : null,
      examCoverage: plan.exam_coverage,
      lensesCoverage: plan.lenses_coverage,
      framesCoverage: plan.frames_coverage,
      copaySummary: plan.copay_summary,
      additionalFeatures: plan.additional_features,
    }))
    .sort((a, b) => (a.annualPremium || 0) - (b.annualPremium || 0));
}

function fmt(n) {
  if (n == null || isNaN(n)) return '—';
  return '$' + Math.round(n).toLocaleString();
}

// ===== DESIGN TOKENS =====
// Direction: "statement of benefits". The subject is an official document nobody
// enjoys reading, so the page borrows its authority - tabular figures, ruled ledger
// rows, form-code chips - and drops its dreariness. Archivo is a sturdy grotesque
// with the flavour of government signage; Inter carries body text; IBM Plex Mono
// sets every dollar figure so columns of money align to the digit.

const FONT_DISPLAY = "'Archivo', 'Helvetica Neue', Arial, sans-serif";
const FONT_SANS = "'Inter', -apple-system, 'Segoe UI', Roboto, sans-serif";
const FONT_MONO = "'IBM Plex Mono', 'SF Mono', Consolas, monospace";
// Alias: ~60 existing call sites reference FONT_SERIF. Pointing it at the display
// face updates all of them at once rather than editing every site.
const FONT_SERIF = FONT_DISPLAY;

const COLORS = {
  paper: '#EDF1F5',
  paperDeep: '#E1E8EE',
  ink: '#0A1922',
  inkSoft: '#54677A',
  rule: '#D9E2E9',
  // "navy" now holds deep petrol. Key names kept so every call site stays valid.
  navy: '#0D4A57',
  navySoft: '#166B7C',
  // "rust"/"rustSoft" hold the value-signal green. Money saved reads green, and this
  // is the only saturated colour on the page - reserved for the cheapest option.
  rust: '#00875A',
  rustSoft: '#E2F5EC',
  good: '#0B7A52',
  goodBg: '#E2F5EC',
  warn: '#8A5D00',
  warnBg: '#FBF1DA',
  bad: '#B02A2A',
  badBg: '#FBEAEA',
  white: '#FFFFFF',
  deep: '#062730',
  deepAlt: '#0B3D4A',
  onDeep: '#C9DDE3',
};

const MAXW_PAGE = 1080;   // header rail
const MAXW_MAIN = 880;    // content column
const MAXW_FORM = 660;    // forms and prose: narrow enough to stay readable

const SHADOW_CARD = '0 1px 2px rgba(10,25,34,0.05), 0 2px 10px -3px rgba(10,25,34,0.07)';
const SHADOW_RAISED = '0 2px 4px rgba(10,25,34,0.04), 0 20px 40px -14px rgba(10,25,34,0.18)';
const SHADOW_BEST = `0 0 0 1.5px ${COLORS.rust}, 0 22px 48px -16px rgba(0,135,90,0.30)`;

function GlobalStyle() {
  return (
    <style>{`
      /* Fonts are requested once, from the <link> in index.html. An @import here
         would fire a second, duplicate request and block rendering while it resolved. */
      .fehb-num { font-family: ${FONT_MONO}; font-feature-settings: "tnum"; letter-spacing: -0.02em; }
      .fehb-root * { box-sizing: border-box; }
      .fehb-root { -webkit-font-smoothing: antialiased; }
      .fehb-root a { color: inherit; }
      .fehb-root input[type=radio] { accent-color: ${COLORS.navy}; }

      .fehb-root :focus-visible { outline: 2px solid ${COLORS.rust}; outline-offset: 2px; border-radius: 4px; }
      .fehb-root input:focus, .fehb-root select:focus { outline: 2px solid ${COLORS.navy}; outline-offset: 1px; }

      /* ---- Header ---- */
      .fehb-header { position: sticky; top: 0; z-index: 900; background: ${COLORS.deep}; border-bottom: 1px solid rgba(255,255,255,0.09); }
      .fehb-header-inner { max-width: ${MAXW_PAGE}px; margin: 0 auto; padding: 0 22px; height: 62px; display: flex; align-items: center; justify-content: space-between; gap: 18px; }
      .fehb-brand { display: flex; align-items: center; gap: 10px; background: none; border: none; padding: 0; cursor: pointer; }
      .fehb-mark { width: 30px; height: 30px; border-radius: 8px; flex-shrink: 0; background: ${COLORS.rust}; color: #042A20; display: flex; align-items: center; justify-content: center; font-family: ${FONT_DISPLAY}; font-weight: 700; font-size: 0.8rem; letter-spacing: -0.02em; }
      .fehb-wordmark { font-family: ${FONT_DISPLAY}; font-weight: 700; font-size: 1.06rem; letter-spacing: -0.02em; color: #fff; }
      .fehb-nav { display: flex; align-items: center; gap: 2px; }
      .fehb-nav-link { background: none; border: none; cursor: pointer; font-family: ${FONT_SANS}; font-size: 0.85rem; font-weight: 500; color: ${COLORS.onDeep}; padding: 7px 12px; border-radius: 7px; transition: background 0.15s ease, color 0.15s ease; }
      .fehb-nav-link:hover { background: rgba(255,255,255,0.09); color: #fff; }
      .fehb-nav-link[data-active="true"] { color: #fff; font-weight: 600; background: rgba(255,255,255,0.12); }
      .fehb-nav-rule { width: 1px; height: 20px; background: rgba(255,255,255,0.16); margin: 0 8px; }
      .fehb-nav-about { color: #fff; font-weight: 600; }

      /* ---- Hero ---- */
      .fehb-hero { background: radial-gradient(1100px 300px at 78% -30%, ${COLORS.deepAlt} 0%, transparent 62%), ${COLORS.deep}; color: #fff; padding: 52px 22px 94px; }
      .fehb-hero-inner { max-width: ${MAXW_MAIN}px; margin: 0 auto; text-align: center; }
      .fehb-eyebrow { font-family: ${FONT_MONO}; font-size: 0.7rem; font-weight: 600; letter-spacing: 0.13em; text-transform: uppercase; color: #38C08D; }
      .fehb-hero h1 { font-family: ${FONT_DISPLAY}; font-weight: 700; font-size: clamp(2rem, 5.2vw, 3.05rem); line-height: 1.06; letter-spacing: -0.032em; margin: 14px auto 0; max-width: 20ch; }
      .fehb-hero-sub { color: ${COLORS.onDeep}; font-size: 1.02rem; line-height: 1.6; margin: 16px auto 0; max-width: 54ch; }
      .fehb-hero-scope { color: rgba(201,221,227,0.7); font-size: 0.81rem; line-height: 1.55; margin: 14px auto 0; max-width: 64ch; }
      .fehb-stats { display: flex; justify-content: center; margin-top: 30px; flex-wrap: wrap; row-gap: 16px; }
      .fehb-stat { padding-right: 30px; margin-right: 30px; border-right: 1px solid rgba(255,255,255,0.15); }
      .fehb-stat:last-child { border-right: none; margin-right: 0; padding-right: 0; }
      .fehb-stat-v { font-family: ${FONT_MONO}; font-feature-settings: "tnum"; font-size: 1.65rem; font-weight: 600; letter-spacing: -0.03em; line-height: 1; }
      .fehb-stat-l { font-size: 0.76rem; color: ${COLORS.onDeep}; margin-top: 6px; }

      /* ---- Content rail overlaps the hero band ---- */
      .fehb-main { max-width: ${MAXW_MAIN}px; margin: -60px auto 0; padding: 0 22px 80px; position: relative; z-index: 1; }

      /* ---- Segmented coverage control ---- */
      .fehb-tabs { display: flex; width: fit-content; gap: 3px; padding: 4px; margin: 0 auto 22px; background: ${COLORS.white}; border-radius: 12px; box-shadow: ${SHADOW_CARD}; }
      .fehb-tab { border: none; cursor: pointer; background: transparent; font-family: ${FONT_SANS}; font-size: 0.87rem; font-weight: 600; color: ${COLORS.inkSoft}; padding: 9px 16px; border-radius: 9px; display: flex; align-items: center; gap: 6px; transition: background 0.15s ease, color 0.15s ease; }
      .fehb-tab:hover { color: ${COLORS.ink}; background: ${COLORS.paper}; }
      .fehb-tab[data-active="true"], .fehb-tab[data-active="true"]:hover { background: ${COLORS.navy}; color: #fff; }
      .fehb-tab-sub { font-family: ${FONT_MONO}; font-size: 0.65rem; font-weight: 500; opacity: 0.6; letter-spacing: 0.04em; }

      /* ---- Cost composition bar: the signature element ---- */
      .fehb-bar { display: flex; height: 7px; border-radius: 4px; overflow: hidden; background: ${COLORS.paperDeep}; }
      .fehb-bar i { display: block; height: 100%; }

      .fehb-btn-primary { transition: transform 0.12s ease, box-shadow 0.16s ease; }
      .fehb-btn-primary:hover { transform: translateY(-1px); box-shadow: ${SHADOW_RAISED}; }
      .fehb-btn-primary:active { transform: translateY(0); }
      .fehb-card { transition: box-shadow 0.18s ease; }
      .fehb-card:hover { box-shadow: ${SHADOW_RAISED}; }

      @media (max-width: 720px) {
        .fehb-header-inner { height: 56px; padding: 0 15px; }
        .fehb-wordmark { font-size: 0.98rem; }
        .fehb-nav-link { padding: 6px 8px; font-size: 0.8rem; }
        .fehb-nav-rule { margin: 0 4px; }
        .fehb-hero { padding: 34px 16px 78px; }
        .fehb-hero-sub { font-size: 0.94rem; }
        .fehb-main { padding: 0 15px 60px; margin-top: -52px; }
        .fehb-stat { padding-right: 18px; margin-right: 18px; }
        .fehb-stat-v { font-size: 1.35rem; }
        .fehb-tabs { display: flex; width: 100%; margin: 0 0 18px; }
        .fehb-tab { flex: 1; justify-content: center; padding: 9px 6px; font-size: 0.82rem; }
        .fehb-tab-sub { display: none; }
      }
      @media (max-width: 430px) { .fehb-nav-link[data-coverage] { display: none; } }

      @media (prefers-reduced-motion: no-preference) { .fehb-card { animation: fehb-rise 0.32s cubic-bezier(0.22,1,0.36,1) backwards; } }
      @media (prefers-reduced-motion: reduce) { .fehb-root * { animation: none !important; transition: none !important; } }
      @keyframes fehb-rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    `}</style>
  );
}

function FormTag({ children }) {
  return (
    <span className="fehb-num" style={{
      fontSize: '0.68rem', fontWeight: 700, color: COLORS.navy,
      background: COLORS.rustSoft, border: 'none', borderRadius: 5, padding: '3px 7px',
      letterSpacing: '0.02em', whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  );
}

function renderSimpleMarkdown(text) {
  const lines = text.split('\n');
  const elements = [];
  let listItems = [];

  const flushList = () => {
    if (listItems.length) {
      elements.push(<ul key={`list-${elements.length}`} style={{ paddingLeft: 20, marginBottom: 12 }}>{listItems}</ul>);
      listItems = [];
    }
  };

  lines.forEach((line, i) => {
    const renderInline = (s) => s.split(/(\*\*[^*]+\*\*)/).map((part, j) =>
      part.startsWith('**') && part.endsWith('**')
        ? <strong key={j}>{part.slice(2, -2)}</strong>
        : part
    );

    if (line.startsWith('# ')) {
      flushList();
      elements.push(<h1 key={i} style={{ fontFamily: FONT_SERIF, fontSize: '1.5rem', marginTop: 0 }}>{line.slice(2)}</h1>);
    } else if (line.startsWith('## ')) {
      flushList();
      elements.push(<h2 key={i} style={{ fontFamily: FONT_SERIF, fontSize: '1.1rem', marginTop: 20, marginBottom: 8 }}>{line.slice(3)}</h2>);
    } else if (line.startsWith('- ')) {
      listItems.push(<li key={i} style={{ marginBottom: 4, lineHeight: 1.5 }}>{renderInline(line.slice(2))}</li>);
    } else if (line.trim() === '') {
      flushList();
    } else {
      flushList();
      elements.push(<p key={i} style={{ lineHeight: 1.6, marginBottom: 10 }}>{renderInline(line)}</p>);
    }
  });
  flushList();
  return elements;
}

// ===== ABOUT PAGE =====
//
// ---------------------------------------------------------------------------
// EDIT THIS BLOCK to add the three team profiles. Nothing else needs to change.
//
//   name   - displayed in bold
//   role   - one short line under the name
//   bio    - one or two sentences; plain text, no markdown
//   photo  - path to an image in /public/team/ (e.g. '/team/jane.jpg').
//            Set to null and the card shows the person's initials instead, so
//            the layout is not broken while you are still gathering photos.
//            Use a square image, at least 320x320px. JPG or WebP.
//   link   - optional LinkedIn/personal URL. Set to null to omit.
// ---------------------------------------------------------------------------
const TEAM = [
  {
    name: 'Nehal Hiremath',
    role: 'Student researcher — healthcare and robotics',
    bio: 'Nehal is a high school student passionate about medicine, technology, and innovation. He has spent 200+ hours volunteering in healthcare settings and gained clinical exposure through summer shadowing experiences in radiology, cardiovascular care, and internal medicine. With 2 years of robotics experience, he has contributed to programming, mechanical design, electrical systems, and fundraising, while also helping coordinate a robotics event for 40+ students. Through his experiences in both healthcare and engineering, Nehal explores the intersection of technology and patient care, using innovation to better understand and improve the future of medicine.',
    photo: '/team/nehal-hiremath.jpg',
    link: null,
  },
  {
    name: 'Tanya Ramesh',
    role: 'Student leader — healthcare advocacy and community service',
    bio: 'Tanya is a co-founder of Rural Healthcare Today, a nonprofit addressing resource gaps in medically underserved rural communities. She was named Kansas State Civics Bee Champion and placed fourth nationally in Washington, D.C. for her work on rural healthcare access. She has volunteered 100+ hours at the Robert J. Dole VA Medical Center, shadowed physicians in pediatrics, cardiology, and internal medicine, and competes nationally through HOSA. She is CPR certified, and holds state titles in tennis, debate, and forensics.',
    photo: '/team/tanya-ramesh.jpg',
    link: null,
  },
  {
    name: 'Varsha Vivekananda',
    // TODO before publishing: role and bio still needed.
    role: 'Role or title',
    bio: 'Bio pending.',
    photo: null,
    link: null,
  },
];

function initialsOf(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
}

function TeamCard({ person }) {
  const [imgFailed, setImgFailed] = useState(false);
  const showPhoto = person.photo && !imgFailed;

  return (
    <div style={{
      display: 'flex', gap: 14, alignItems: 'flex-start', padding: '14px 0',
      borderTop: `1px solid ${COLORS.rule}`,
    }}>
      {showPhoto ? (
        <img
          src={person.photo}
          alt=""
          onError={() => setImgFailed(true)}
          style={{
            width: 58, height: 58, borderRadius: '50%', objectFit: 'cover',
            flexShrink: 0, background: COLORS.paperDeep,
          }}
        />
      ) : (
        <div aria-hidden="true" style={{
          width: 58, height: 58, borderRadius: '50%', flexShrink: 0,
          background: COLORS.navy, color: COLORS.white,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: FONT_SERIF, fontWeight: 700, fontSize: '1.15rem',
        }}>
          {initialsOf(person.name)}
        </div>
      )}

      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: '0.95rem', color: COLORS.ink }}>
          {person.name}
        </div>
        <div style={{ fontSize: '0.8rem', color: COLORS.navySoft, fontWeight: 600, marginTop: 1 }}>
          {person.role}
        </div>
        <p style={{ fontSize: '0.85rem', color: COLORS.inkSoft, lineHeight: 1.55, margin: '6px 0 0' }}>
          {person.bio}
        </p>
        {person.link && (
          <a
            href={person.link} target="_blank" rel="noreferrer"
            style={{ fontSize: '0.8rem', color: COLORS.navySoft, textDecoration: 'underline', display: 'inline-block', marginTop: 5 }}
          >
            More about {person.name.split(' ')[0]}
          </a>
        )}
      </div>
    </div>
  );
}

function AboutModal({ onClose }) {
  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 2000,
      background: 'rgba(28,26,23,0.5)', display: 'flex', alignItems: 'flex-end',
    }} onClick={onClose}>
      <div
        role="dialog" aria-modal="true" aria-labelledby="about-heading"
        style={{
          background: COLORS.paper, width: '100%', maxHeight: '85vh', overflowY: 'auto',
          borderRadius: '16px 16px 0 0', padding: '20px 22px 32px', fontFamily: FONT_SANS,
          color: COLORS.ink, fontSize: '0.88rem',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
          <button onClick={onClose} aria-label="Close" style={{
            background: 'none', border: 'none', fontSize: '1.3rem', cursor: 'pointer', color: COLORS.inkSoft,
          }}>×</button>
        </div>

        <div style={{ maxWidth: 640, margin: '0 auto' }}>
          <h2 id="about-heading" style={{
            fontFamily: FONT_SERIF, fontSize: '1.6rem', fontWeight: 700, margin: '0 0 12px',
            letterSpacing: '-0.01em', lineHeight: 1.2,
          }}>
            About InsuCompare
          </h2>

          <p style={{ lineHeight: 1.6, color: COLORS.inkSoft, margin: '0 0 14px' }}>
            Every Open Season, federal employees are asked to choose between dozens of health plans
            described in hundreds of pages of brochures, with the one number that matters most —
            what this will actually cost me over a year — left for each person to work out on their
            own. InsuCompare does that arithmetic in one place, using OPM's own published plan and
            rate data.
          </p>

          <p style={{ lineHeight: 1.6, color: COLORS.inkSoft, margin: '0 0 14px' }}>
            The tool is free, needs no account, and collects nothing about you. Your ZIP code,
            enrollment type, and any medications you enter stay in your browser — they are never
            sent to a server, never stored, and never shared.
          </p>

          <h3 style={{ fontFamily: FONT_SERIF, fontSize: '1.15rem', fontWeight: 700, margin: '22px 0 8px' }}>
            What this is, and what it isn't
          </h3>
          <p style={{ lineHeight: 1.6, color: COLORS.inkSoft, margin: '0 0 14px' }}>
            This is a comparison worksheet, not insurance advice. The figures shown are estimates
            built on published rates plus a simplified model of how much care you expect to use, and
            they deliberately leave out things a full projection would include — most notably the
            deductible and the out-of-pocket maximum. We say so plainly on every set of results
            rather than presenting a single confident number, because the honest version is more
            useful than the tidy one. Before you enroll, check the plan brochure and OPM's official
            comparison tool.
          </p>

          <h3 style={{ fontFamily: FONT_SERIF, fontSize: '1.15rem', fontWeight: 700, margin: '22px 0 4px' }}>
            Who we are
          </h3>
          <div style={{ marginTop: 4 }}>
            {TEAM.map(person => <TeamCard key={person.name} person={person} />)}
          </div>

          <p style={{
            fontSize: '0.8rem', color: COLORS.inkSoft, lineHeight: 1.55,
            marginTop: 22, paddingTop: 14, borderTop: `1px solid ${COLORS.rule}`,
          }}>
            InsuCompare is an independent project. It is not affiliated with, endorsed by, or
            operated by the U.S. Office of Personnel Management, any federal agency, or any
            insurance carrier.
          </p>
        </div>
      </div>
    </div>
  );
}

function LegalModal({ path, onClose }) {
  const [text, setText] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);

  React.useEffect(() => {
    fetch(path)
      .then(r => { if (!r.ok) throw new Error('not found'); return r.text(); })
      .then(setText)
      .catch(() => setLoadFailed(true));
  }, [path]);

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 2000,
      background: 'rgba(28,26,23,0.5)', display: 'flex', alignItems: 'flex-end',
    }} onClick={onClose}>
      <div
        style={{
          background: COLORS.paper, width: '100%', maxHeight: '85vh', overflowY: 'auto',
          borderRadius: '16px 16px 0 0', padding: '20px 22px 32px', fontFamily: FONT_SANS,
          color: COLORS.ink, fontSize: '0.88rem',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', fontSize: '1.3rem', cursor: 'pointer', color: COLORS.inkSoft,
          }}>×</button>
        </div>
        {loadFailed && <p>Sorry, this couldn't be loaded right now.</p>}
        {!loadFailed && text == null && <p>Loading…</p>}
        {text != null && renderSimpleMarkdown(text)}
      </div>
    </div>
  );
}

export default function FEHBComparison() {
  const [data, setData] = useState(null);
  const [dentalData, setDentalData] = useState(null);
  const [visionPlans, setVisionPlans] = useState(null);
  const [dataLoadError, setDataLoadError] = useState(null);

  const [coverageType, setCoverageType] = useState('medical');

  // Plan data is loaded per tab rather than all at once. The two ZIP lookup files
  // are ~215KB gzipped between them and are irrelevant to the vision tab, so
  // loading everything up front made the first paint slower for no benefit.
  // Each tab's data is fetched the first time that tab is opened, then cached.
  const requestedTabs = React.useRef(new Set());

  React.useEffect(() => {
    if (requestedTabs.current.has(coverageType)) return;
    requestedTabs.current.add(coverageType);

    const fetchJson = (path) => fetch(path).then(r => {
      if (!r.ok) throw new Error(`Failed to load ${path}`);
      return r.json();
    });

    async function loadTabData() {
      try {
        if (coverageType === 'medical') {
          const [zipInfo, fipsToPlans, stateToPlans, nationwideCodes, plans, rates, formulary] =
            await Promise.all([
              fetchJson('/data/medical_zip_info.json'),
              fetchJson('/data/medical_fips_to_plans.json'),
              fetchJson('/data/medical_state_to_plans.json'),
              fetchJson('/data/medical_nationwide_codes.json'),
              fetchJson('/data/medical_plans.json'),
              fetchJson('/data/medical_rates.json'),
              fetchJson('/data/formulary.json'),
            ]);
          setData({ zipInfo, fipsToPlans, stateToPlans, nationwideCodes, plans, rates, formulary });
        } else if (coverageType === 'dental') {
          const [zipRegion, carrierCodes, plans, rates] = await Promise.all([
            fetchJson('/data/dental_zip_region.json'),
            fetchJson('/data/dental_carrier_codes.json'),
            fetchJson('/data/dental_plans.json'),
            fetchJson('/data/dental_rates.json'),
          ]);
          setDentalData({ zipRegion, carrierCodes, plans, rates });
        } else if (coverageType === 'vision') {
          setVisionPlans(await fetchJson('/data/vision_plans.json'));
        }
      } catch (err) {
        // Allow a retry on the next tab visit rather than caching the failure.
        requestedTabs.current.delete(coverageType);
        setDataLoadError('Failed to load plan data. Please refresh the page and try again.');
      }
    }
    loadTabData();
  }, [coverageType]);
  const [zipCode, setZipCode] = useState('');
  const [enrollmentType, setEnrollmentType] = useState('Self Only');
  const [usageKey, setUsageKey] = useState('routine');
  const [drugsInput, setDrugsInput] = useState('');
  const [results, setResults] = useState(null);
  const [viewMode, setViewMode] = useState('cards');
  const [error, setError] = useState(null);
  const [submitted, setSubmitted] = useState(false);
  // True when the ZIP is not in medical_zip_info.json. The comparison still runs,
  // but it can only show nationwide plans - so the user has to be told, or they
  // will read a partial list as a complete one.
  const [zipUnknown, setZipUnknown] = useState(false);

  const [dentalUsageLevel, setDentalUsageLevel] = useState('medium');
  const [dentalResults, setDentalResults] = useState(null);
  const [dentalError, setDentalError] = useState(null);
  const [dentalSubmitted, setDentalSubmitted] = useState(false);

  const [visionResults, setVisionResults] = useState(null);
  const [legalModal, setLegalModal] = useState(null); // null | 'privacy' | 'terms' | 'about'

  const handleVisionSubmit = (e) => {
    e.preventDefault();
    setVisionResults(compareVisionPlans({ enrollmentType }, visionPlans));
  };

  const resetVision = () => setVisionResults(null);

  const handleDentalSubmit = (e) => {
    e.preventDefault();
    setDentalError(null);
    setDentalResults(null);
    setDentalSubmitted(true);

    if (!/^\d{5}$/.test(zipCode)) {
      setDentalError('Enter a valid 5-digit ZIP code.');
      return;
    }
    if (!dentalData) {
      setDentalError('Dental plan data failed to load. Please refresh and try again.');
      return;
    }
    try {
      const res = compareDentalPlans({ zipCode, enrollmentType, usageLevel: dentalUsageLevel }, dentalData);
      if (res.length === 0) {
        setDentalError('No FEDVIP dental plans found for that ZIP code. Double-check the ZIP — this may be outside current coverage.');
      } else {
        setDentalResults(res);
      }
    } catch (err) {
      setDentalError('Something went wrong while comparing dental plans: ' + err.message);
    }
  };

  const resetDental = () => {
    setDentalResults(null);
    setDentalError(null);
    setDentalSubmitted(false);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    setError(null);
    setResults(null);
    setSubmitted(true);

    if (!/^\d{5}$/.test(zipCode)) {
      setError('Enter a valid 5-digit ZIP code.');
      return;
    }
    if (!data) {
      setError('Plan data failed to load. Please refresh and try again.');
      return;
    }
    setZipUnknown(!data.zipInfo[zipCode]);
    const drugs = drugsInput.split(',').map(d => d.trim()).filter(Boolean);
    try {
      const res = comparePlans({ zipCode, enrollmentType, usageKey, drugs }, data);
      if (res.length === 0) {
        setError('No FEHB plans found for that ZIP code. Double-check the ZIP — this may be outside current coverage.');
      } else {
        setResults(res);
      }
    } catch (err) {
      setError('Something went wrong while comparing plans: ' + err.message);
    }
  };

  const reset = () => {
    setResults(null);
    setError(null);
    setSubmitted(false);
    setZipUnknown(false);
  };

  if (dataLoadError) {
    return (
      <div style={{
        maxWidth: 480, margin: '60px auto', padding: 24, fontFamily: FONT_SANS,
        textAlign: 'center', color: COLORS.bad,
      }}>
        {dataLoadError}
      </div>
    );
  }

  // Only the active tab's data needs to be present to render that tab. The header,
  // hero, and tab nav stay on screen while a newly opened tab loads, so switching
  // tabs no longer blanks the whole page.
  const tabReady = (
    (coverageType === 'medical' && data) ||
    (coverageType === 'dental' && dentalData) ||
    (coverageType === 'vision' && visionPlans)
  );

  return (
    <div className="fehb-root" style={{
      margin: 0, fontFamily: FONT_SANS, color: COLORS.ink, background: COLORS.paper, minHeight: '100vh',
    }}>
      <GlobalStyle />

      <SiteHeader
        coverageType={coverageType}
        setCoverageType={setCoverageType}
        onAbout={() => setLegalModal('about')}
      />

      <PlanYearNotice />

      <Hero coverageType={coverageType} />

      <main className="fehb-main">
        <nav className="fehb-tabs" aria-label="Coverage type">
          {COVERAGE_TABS.map(t => (
            <TabLink
              key={t.key}
              active={coverageType === t.key}
              onClick={() => setCoverageType(t.key)}
              label={t.label}
              program={t.program}
            />
          ))}
        </nav>

        {!tabReady ? (
          <div style={{
            padding: '48px 24px', textAlign: 'center', color: COLORS.inkSoft, fontSize: '0.9rem',
          }}>
            Loading plan data…
          </div>
        ) : (
        <>

        {(results || error) && submitted && coverageType === 'medical' && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
            <button onClick={reset} style={{
              background: 'none', border: `1px solid ${COLORS.rule}`, borderRadius: 6,
              color: COLORS.navy, fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer',
              padding: '6px 10px', fontFamily: FONT_SANS,
            }}>
              &larr; New search
            </button>
          </div>
        )}

      {coverageType === 'medical' && (
      <>
      {!results && (
        <form onSubmit={handleSubmit} style={{
          background: COLORS.white, border: 'none', borderRadius: 16, padding: 28,
          boxShadow: SHADOW_RAISED, maxWidth: MAXW_FORM, margin: '0 auto',
        }}>
          <Field label="ZIP code" controlId="medical-zip">
            <input
              id="medical-zip"
              type="text" inputMode="numeric" maxLength={5} placeholder="e.g. 77019"
              value={zipCode} onChange={e => setZipCode(e.target.value.replace(/\D/g, ''))}
              className="fehb-num"
              style={inputStyle()}
            />
          </Field>

          <Field label="Enrollment type" controlId="medical-enrollment">
            <select id="medical-enrollment" value={enrollmentType} onChange={e => setEnrollmentType(e.target.value)} style={inputStyle()}>
              {ENROLLMENT_TYPES.map(opt => <option key={opt} value={opt}>{opt}</option>)}
            </select>
          </Field>

          <Field label="Which sounds most like your year?" controlId="medical-usage" group>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 4 }}>
              {Object.entries(USAGE_PROFILES).map(([key, profile]) => {
                const isSelected = usageKey === key;
                return (
                  <label key={key} style={{
                    display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.83rem',
                    padding: '11px 12px', borderRadius: 9, cursor: 'pointer',
                    border: `1.5px solid ${isSelected ? COLORS.navy : COLORS.rule}`,
                    background: isSelected ? COLORS.rustSoft : COLORS.white,
                    boxShadow: isSelected ? '0 2px 6px rgba(22,36,63,0.14)' : 'none',
                    transition: 'all 0.12s ease',
                  }}>
                    <input type="radio" name="usage" checked={isSelected} onChange={() => setUsageKey(key)} style={{ flexShrink: 0 }} />
                    <span style={{ fontWeight: 600, color: COLORS.ink, lineHeight: 1.3 }}>{profile.label}</span>
                  </label>
                );
              })}
            </div>
            <div style={{
              marginTop: 9, fontSize: '0.8rem', color: COLORS.inkSoft, lineHeight: 1.5,
              padding: '9px 13px', background: COLORS.rustSoft, borderRadius: '0 8px 8px 0',
                    borderLeft: `3px solid ${COLORS.rust}`,
            }}>
              {USAGE_PROFILES[usageKey].detail}
            </div>
          </Field>

          <Field label="Medications you take (optional)" controlId="medical-drugs">
            <div style={{ fontSize: '0.78rem', color: COLORS.inkSoft, marginBottom: 7, lineHeight: 1.4 }}>
              Separate multiple drugs with commas, e.g. "Ozempic, Atorvastatin". Estimated for Blue Cross and Blue Shield, GEHA, UnitedHealthcare, Aetna, Kaiser (all regions) and CareFirst plans — 59 of the 118 plan options. Others are marked unknown.
            </div>
            <input
              id="medical-drugs"
              type="text" placeholder="Ozempic, Atorvastatin"
              value={drugsInput} onChange={e => setDrugsInput(e.target.value)}
              style={inputStyle()}
            />
            <div style={{
              fontSize: '0.75rem', color: COLORS.warn, background: COLORS.warnBg,
              borderLeft: `3px solid ${COLORS.warn}`, borderRadius: '0 7px 7px 0',
              padding: '9px 12px', marginTop: 9, lineHeight: 1.5,
            }}>
              <strong>Check drug costs against your plan's own formulary.</strong> The per-tier
              prices here are {DATA_PLAN_YEAR} figures from OPM, but which tier a given drug sits in
              is carried over from the {DATA_PLAN_YEAR - 1} formularies and has not been
              re-verified for {DATA_PLAN_YEAR}. Plans move drugs between tiers every year, and
              GLP-1 coverage in particular has been changing. Each plan card links to its
              {' '}{DATA_PLAN_YEAR} formulary.
            </div>
          </Field>

          <button type="submit" className="fehb-btn-primary" style={{
            width: '100%', marginTop: 22, padding: '13px', fontSize: '0.95rem', fontWeight: 600,
            border: 'none', borderRadius: 10, background: COLORS.navy, color: COLORS.white, cursor: 'pointer',
            fontFamily: FONT_SANS, letterSpacing: '0.01em', boxShadow: '0 2px 8px rgba(22,36,63,0.30)',
          }}>
            Compare plans
          </button>
        </form>
      )}

      {error && (
        <div style={{
          background: COLORS.badBg, border: `1px solid ${COLORS.bad}33`, color: COLORS.bad,
          padding: '14px 16px', borderRadius: 8, fontSize: '0.9rem', marginTop: 16, lineHeight: 1.5,
        }}>
          {error}
        </div>
      )}

      {results && (
        <div style={{ marginTop: 18 }}>
          {zipUnknown && (
            <div style={{
              fontSize: '0.78rem', color: COLORS.ink, background: COLORS.rustSoft,
              border: `1px solid ${COLORS.navySoft}`, borderRadius: 8, padding: '11px 13px',
              marginBottom: 12, lineHeight: 1.5,
            }}>
              <strong>This ZIP code isn't in our local plan lookup.</strong> The list below shows
              nationwide plans only — any regional or HMO plans available where you live are
              missing from it. Double-check the ZIP, and check OPM's plan comparison tool directly
              before ruling anything out.
            </div>
          )}

          <div style={{
            fontSize: '0.78rem', color: COLORS.inkSoft, background: COLORS.paperDeep,
            border: `1px solid ${COLORS.rule}`, borderRadius: 8, padding: '11px 13px', marginBottom: 18, lineHeight: 1.5,
          }}>
            These are <strong style={{ color: COLORS.ink }}>estimates</strong> based on OPM's published plan data and a simplified usage model — not a guarantee of your actual costs. Coinsurance-based costs use a placeholder assumed price per visit/fill, since real costs depend on the specific service and provider.
            <div style={{ marginTop: 8 }}>
              Each plan shows two figures. <strong style={{ color: COLORS.ink }}>Typical year</strong> is
              premium plus estimated copays — it does not include the deductible, so plans with a high
              deductible look cheaper here than they will be in a year when you actually use
              care. <strong style={{ color: COLORS.ink }}>Most you could pay</strong> is premium plus the
              plan's out-of-pocket maximum: the ceiling in a bad year. Plans are sorted by the first
              number, so read both before choosing — a plan can win on one and lose badly on the
              other. Neither figure credits the HSA or HRA contribution that high-deductible plans
              make on your behalf.
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
            <ViewToggle active={viewMode === 'cards'} onClick={() => setViewMode('cards')}>Card view</ViewToggle>
            <ViewToggle active={viewMode === 'table'} onClick={() => setViewMode('table')}>Compare side by side</ViewToggle>
          </div>

          {viewMode === 'table' && <LedgerTable results={results} enrollmentType={enrollmentType} drugsInput={drugsInput} />}

          {viewMode === 'cards' && (() => {
            // Shared scale so every card's bar is measured against the same maximum.
            const scaleMax = Math.max(...results.map(r => r.grandTotal || 0));
            return results.map((plan, idx) => (
              <PlanCard
                key={plan.planCode} plan={plan} idx={idx}
                enrollmentType={enrollmentType} drugsInput={drugsInput} scaleMax={scaleMax}
              />
            ));
          })()}
        </div>
      )}
      </>
      )}

      {coverageType === 'dental' && (
      <>
      {!dentalResults && (
        <form onSubmit={handleDentalSubmit} style={{
          background: COLORS.white, border: 'none', borderRadius: 16, padding: 28,
          boxShadow: SHADOW_RAISED, maxWidth: MAXW_FORM, margin: '0 auto',
        }}>
          <Field label="ZIP code" controlId="dental-zip">
            <input
              id="dental-zip"
              type="text" inputMode="numeric" maxLength={5} placeholder="e.g. 77019"
              value={zipCode} onChange={e => setZipCode(e.target.value.replace(/\D/g, ''))}
              className="fehb-num"
              style={inputStyle()}
            />
          </Field>

          <Field label="Enrollment type" controlId="dental-enrollment">
            <select id="dental-enrollment" value={enrollmentType} onChange={e => setEnrollmentType(e.target.value)} style={inputStyle()}>
              {ENROLLMENT_TYPES.map(opt => <option key={opt} value={opt}>{opt}</option>)}
            </select>
          </Field>

          <Field label="Expected dental care this year" controlId="dental-usage" group>
            {(() => {
              const dentalOptions = [
                { key: 'low', label: 'Routine cleanings', detail: 'Two checkups/cleanings a year, nothing else expected.' },
                { key: 'medium', label: 'A filling or two', detail: 'Routine care plus some basic restorative work during the year.' },
                { key: 'high', label: 'Major work expected', detail: 'Crowns, root canals, or similar — a year with significant dental work.' },
              ];
              const selected = dentalOptions.find(o => o.key === dentalUsageLevel);
              return (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 4 }}>
                    {dentalOptions.map(opt => {
                      const isSelected = dentalUsageLevel === opt.key;
                      return (
                        <label key={opt.key} style={{
                          display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.78rem',
                          padding: '10px 9px', borderRadius: 9, cursor: 'pointer',
                          border: `1.5px solid ${isSelected ? COLORS.navy : COLORS.rule}`,
                          background: isSelected ? COLORS.rustSoft : COLORS.white,
                          boxShadow: isSelected ? '0 2px 6px rgba(22,36,63,0.14)' : 'none',
                        }}>
                          <input type="radio" name="dentalUsage" checked={isSelected} onChange={() => setDentalUsageLevel(opt.key)} style={{ flexShrink: 0 }} />
                          <span style={{ fontWeight: 600, color: COLORS.ink, lineHeight: 1.25 }}>{opt.label}</span>
                        </label>
                      );
                    })}
                  </div>
                  <div style={{
                    marginTop: 9, fontSize: '0.8rem', color: COLORS.inkSoft, lineHeight: 1.5,
                    padding: '9px 13px', background: COLORS.rustSoft, borderRadius: '0 8px 8px 0',
                    borderLeft: `3px solid ${COLORS.rust}`,
                  }}>
                    {selected.detail}
                  </div>
                </>
              );
            })()}
          </Field>

          <button type="submit" className="fehb-btn-primary" style={{
            width: '100%', marginTop: 22, padding: '13px', fontSize: '0.95rem', fontWeight: 600,
            border: 'none', borderRadius: 10, background: COLORS.navy, color: COLORS.white, cursor: 'pointer',
            fontFamily: FONT_SANS, letterSpacing: '0.01em', boxShadow: '0 2px 8px rgba(22,36,63,0.30)',
          }}>
            Compare dental plans
          </button>
        </form>
      )}

      {dentalError && (
        <div style={{
          background: COLORS.badBg, border: `1px solid ${COLORS.bad}33`, color: COLORS.bad,
          padding: '14px 16px', borderRadius: 8, fontSize: '0.9rem', marginTop: 16, lineHeight: 1.5,
        }}>
          {dentalError}
        </div>
      )}

      {dentalResults && (
        <div style={{ marginTop: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
            <button onClick={resetDental} style={{
              background: 'none', border: `1px solid ${COLORS.rule}`, borderRadius: 6,
              color: COLORS.navy, fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer',
              padding: '6px 10px', fontFamily: FONT_SANS,
            }}>
              &larr; New search
            </button>
          </div>
          <div style={{
            fontSize: '0.78rem', color: COLORS.inkSoft, background: COLORS.paperDeep,
            border: `1px solid ${COLORS.rule}`, borderRadius: 8, padding: '11px 13px', marginBottom: 18, lineHeight: 1.5,
          }}>
            These are <strong style={{ color: COLORS.ink }}>estimates</strong> based on OPM's published FEDVIP dental rate and benefit data. Out-of-pocket estimates use a simplified usage assumption and a placeholder cost per category — actual costs depend on the specific procedures and provider charges. FEDVIP plans are separate from FEHB medical plans and enrolled in independently.
            <div style={{ marginTop: 8 }}>
              As with medical, the total is <strong style={{ color: COLORS.ink }}>premium plus estimated copays only</strong> —
              it does not add the deductible or apply the plan's annual maximum, which is the point
              at which the plan stops paying and you cover the rest.
            </div>
          </div>

          {(() => {
            const scaleMax = Math.max(...dentalResults.map(r => r.grandTotal || 0));
            return dentalResults.map((plan, idx) => (
              <DentalPlanCard
                key={plan.carrierName + plan.planOption} plan={plan} idx={idx} scaleMax={scaleMax}
              />
            ));
          })()}
        </div>
      )}
      </>
      )}

      {coverageType === 'vision' && (
      <>
      {!visionResults && (
        <form onSubmit={handleVisionSubmit} style={{
          background: COLORS.white, border: 'none', borderRadius: 16, padding: 28,
          boxShadow: SHADOW_RAISED, maxWidth: MAXW_FORM, margin: '0 auto',
        }}>
          <div style={{
            fontSize: '0.82rem', color: COLORS.inkSoft, marginBottom: 14, lineHeight: 1.5,
          }}>
            All FEDVIP vision plans are nationwide with flat, location-independent rates — no ZIP code needed.
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 20 }}>
            {['Aetna', 'BCBS FEP', 'MetLife', 'UnitedHealthcare', 'VSP'].map(name => (
              <span key={name} style={{
                fontSize: '0.74rem', fontWeight: 600, color: COLORS.navy, background: COLORS.paperDeep,
                padding: '4px 10px', borderRadius: 20,
              }}>
                {name}
              </span>
            ))}
          </div>
          <Field label="Enrollment type" controlId="vision-enrollment">
            <select id="vision-enrollment" value={enrollmentType} onChange={e => setEnrollmentType(e.target.value)} style={inputStyle()}>
              {ENROLLMENT_TYPES.map(opt => <option key={opt} value={opt}>{opt}</option>)}
            </select>
          </Field>

          <button type="submit" className="fehb-btn-primary" style={{
            width: '100%', marginTop: 22, padding: '13px', fontSize: '0.95rem', fontWeight: 600,
            border: 'none', borderRadius: 10, background: COLORS.navy, color: COLORS.white, cursor: 'pointer',
            fontFamily: FONT_SANS, letterSpacing: '0.01em', boxShadow: '0 2px 8px rgba(22,36,63,0.30)',
          }}>
            Compare vision plans
          </button>
        </form>
      )}

      {visionResults && (
        <div style={{ marginTop: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
            <button onClick={resetVision} style={{
              background: 'none', border: `1px solid ${COLORS.rule}`, borderRadius: 6,
              color: COLORS.navy, fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer',
              padding: '6px 10px', fontFamily: FONT_SANS,
            }}>
              &larr; New search
            </button>
          </div>
          <div style={{
            fontSize: '0.78rem', color: COLORS.inkSoft, background: COLORS.paperDeep,
            border: `1px solid ${COLORS.rule}`, borderRadius: 8, padding: '11px 13px', marginBottom: 18, lineHeight: 1.5,
          }}>
            Premiums are exact figures from OPM's published FEDVIP rate tables. Benefit summaries are shown as published by each carrier — exam/lens/frame coverage typically renews every 12-24 months depending on plan.
          </div>

          {visionResults.map((plan, idx) => (
            <VisionPlanCard key={plan.carrierName + plan.planOption} plan={plan} idx={idx} />
          ))}
        </div>
      )}
      </>
      )}

        </>
        )}
      </main>

      <footer style={{
        marginTop: 32, fontSize: '0.74rem', color: COLORS.inkSoft, textAlign: 'center',
        borderTop: `1px solid ${COLORS.rule}`, paddingTop: 16, paddingBottom: 24, lineHeight: 1.6,
      }}>
        Data: OPM FEHB &amp; FEDVIP Public Use Files, plan year {DATA_PLAN_YEAR}. ZIP lookup:{' '}
        <a href="https://simplemaps.com/data/us-zips" target="_blank" rel="noreferrer" style={{ color: COLORS.navySoft, textDecoration: 'underline' }}>
          SimpleMaps
        </a>
        <div style={{ marginTop: 8 }}>
          <button onClick={() => setLegalModal('about')} style={{
            background: 'none', border: 'none', color: COLORS.navySoft, textDecoration: 'underline',
            cursor: 'pointer', fontSize: '0.74rem', fontFamily: FONT_SANS, padding: '0 6px',
          }}>
            About Us
          </button>
          <span style={{ color: COLORS.rule }}>&middot;</span>
          <button onClick={() => setLegalModal('privacy')} style={{
            background: 'none', border: 'none', color: COLORS.navySoft, textDecoration: 'underline',
            cursor: 'pointer', fontSize: '0.74rem', fontFamily: FONT_SANS, padding: '0 6px',
          }}>
            Privacy Policy
          </button>
          <span style={{ color: COLORS.rule }}>·</span>
          <button onClick={() => setLegalModal('terms')} style={{
            background: 'none', border: 'none', color: COLORS.navySoft, textDecoration: 'underline',
            cursor: 'pointer', fontSize: '0.74rem', fontFamily: FONT_SANS, padding: '0 6px',
          }}>
            Terms of Use
          </button>
        </div>
      </footer>

      {legalModal === 'about' && <AboutModal onClose={() => setLegalModal(null)} />}
      {legalModal === 'privacy' && <LegalModal path="/legal/privacy-policy.md" onClose={() => setLegalModal(null)} />}
      {legalModal === 'terms' && <LegalModal path="/legal/terms-of-use.md" onClose={() => setLegalModal(null)} />}
    </div>
  );
}

function inputStyle() {
  return {
    width: '100%', padding: '11px 13px', fontSize: '0.95rem',
    border: `1.5px solid ${COLORS.rule}`, borderRadius: 9, background: COLORS.white,
    fontFamily: FONT_SANS, color: COLORS.ink,
  };
}

// Two modes, because the two cases need different markup to be announced correctly:
//   <Field label="ZIP code" controlId="medical-zip">  - one control; label uses htmlFor
//   <Field label="..." group>                         - a set of radio-style options;
//                                                       label names a role="group" instead,
//                                                       since htmlFor can only point at one
//                                                       control and nesting <label> inside
//                                                       <label> is invalid HTML.
function Field({ label, controlId, group, children }) {
  const labelStyle = {
    display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: 7,
    color: COLORS.ink, fontFamily: FONT_SANS,
  };

  if (group) {
    const labelId = `${controlId || label.replace(/\W+/g, '-').toLowerCase()}-label`;
    return (
      <div style={{ marginBottom: 18 }}>
        <span id={labelId} style={labelStyle}>{label}</span>
        <div role="group" aria-labelledby={labelId}>{children}</div>
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 18 }}>
      <label htmlFor={controlId} style={labelStyle}>{label}</label>
      {children}
    </div>
  );
}

// ===== PLAN YEAR =====
// DATA_PLAN_YEAR is the year the files in public/data/ actually describe. It is NOT
// the year people are currently shopping for. When the data is refreshed from OPM's
// Public Use Files, bump DATA_PLAN_YEAR and the banner disappears on its own.
const DATA_PLAN_YEAR = 2027;
const CURRENT_SHOPPING_YEAR = 2027;
const OPEN_SEASON_TEXT = 'November 9 \u2013 December 14, 2026';
const OPM_OPEN_SEASON_URL = 'https://www.opm.gov/healthcare-insurance/open-season/';

// Plan codes in this (2026) dataset that OPM has confirmed will NOT be offered in
// 2027. Source: OPM Federal Benefits Open Season Highlights, 2027 Plan Year. Two of
// the nine plans OPM lists (Blue Care Network of Michigan Southeast High, Health Net
// of California Southern Standard) are not present in this dataset. Enrollees in a
// discontinued plan who make no Open Season election are placed in Compass Rose
// Standard. Delete this set when the data is refreshed to 2027 - those plans will
// simply be absent.
// Plans OPM discontinued for 2027 are simply absent from the 2027 files, so no
// per-plan flag is needed any more.
const DISCONTINUED_2027 = new Set();

function PlanYearNotice() {
  // Data year behind the year people are shopping for: loud warning.
  if (DATA_PLAN_YEAR < CURRENT_SHOPPING_YEAR) {
    return (
      <div role="alert" style={{
        background: '#7A2E12', color: '#FFE9DF',
        borderBottom: '1px solid rgba(255,255,255,0.14)', fontFamily: FONT_SANS,
      }}>
        <div style={{ maxWidth: MAXW_PAGE, margin: '0 auto', padding: '12px 22px', fontSize: '0.86rem', lineHeight: 1.55 }}>
          <strong style={{ color: '#fff' }}>
            These are {DATA_PLAN_YEAR} rates. Do not use them to choose {CURRENT_SHOPPING_YEAR} coverage.
          </strong>{' '}
          Open Season for the {CURRENT_SHOPPING_YEAR} plan year runs {OPEN_SEASON_TEXT}. Use{' '}
          <a href={OPM_OPEN_SEASON_URL} target="_blank" rel="noreferrer"
             style={{ color: '#fff', textDecoration: 'underline', fontWeight: 600 }}>
            OPM&rsquo;s official Open Season tools
          </a>.
        </div>
      </div>
    );
  }
  // Data is current: a calm bar confirming which year is priced.
  return (
    <div style={{
      background: COLORS.deepAlt, color: COLORS.onDeep,
      borderBottom: '1px solid rgba(255,255,255,0.1)', fontFamily: FONT_SANS,
    }}>
      <div style={{
        maxWidth: MAXW_PAGE, margin: '0 auto', padding: '9px 22px',
        fontSize: '0.8rem', lineHeight: 1.5, display: 'flex',
        gap: 8, flexWrap: 'wrap', alignItems: 'baseline',
      }}>
        <strong style={{ color: '#fff' }}>{DATA_PLAN_YEAR} plan year rates.</strong>
        <span>Open Season runs {OPEN_SEASON_TEXT} &mdash; changes take effect January 1, {DATA_PLAN_YEAR}.</span>
        <a href={OPM_OPEN_SEASON_URL} target="_blank" rel="noreferrer"
           style={{ color: '#fff', textDecoration: 'underline' }}>
          Enroll at OPM
        </a>
      </div>
    </div>
  );
}

const COVERAGE_TABS = [
  { key: 'medical', label: 'Medical', program: 'FEHB' },
  { key: 'dental', label: 'Dental', program: 'FEDVIP' },
  { key: 'vision', label: 'Vision', program: 'FEDVIP' },
];

function SiteHeader({ coverageType, setCoverageType, onAbout }) {
  return (
    <header className="fehb-header">
      <div className="fehb-header-inner">
        <button className="fehb-brand" onClick={() => setCoverageType('medical')} aria-label="InsuCompare home">
          <span className="fehb-mark" aria-hidden="true">IC</span>
          <span className="fehb-wordmark">InsuCompare</span>
        </button>

        <nav className="fehb-nav" aria-label="Main">
          {COVERAGE_TABS.map(t => (
            <button
              key={t.key}
              data-coverage="true"
              data-active={coverageType === t.key}
              className="fehb-nav-link"
              onClick={() => setCoverageType(t.key)}
            >
              {t.label}
            </button>
          ))}
          <span className="fehb-nav-rule" aria-hidden="true" />
          <button className="fehb-nav-link fehb-nav-about" onClick={onAbout}>About us</button>
        </nav>
      </div>
    </header>
  );
}

function Hero({ coverageType }) {
  const content = {
    medical: {
      eyebrow: 'FEHB medical',
      headline: 'Every plan you can join, priced for your year.',
      copy: 'Enter a ZIP code and roughly how much care you expect to use. We price every FEHB medical plan available where you live and sort them cheapest first.',
      stats: [
        { value: '118', label: 'plan options priced' },
        { value: '45', label: 'carriers' },
        { value: '59', label: 'with drug cost data' },
      ],
    },
    dental: {
      eyebrow: 'FEDVIP dental',
      headline: 'Dental coverage, compared on one page.',
      copy: 'Premiums, deductibles, and what routine or major work will actually cost you, for every FEDVIP dental plan serving your ZIP code.',
      stats: [
        { value: '21', label: 'dental plan options' },
        { value: '11', label: 'carriers' },
        { value: '2', label: 'tiers per carrier' },
      ],
    },
    vision: {
      eyebrow: 'FEDVIP vision',
      headline: 'Vision plans, no ZIP code required.',
      copy: 'Every FEDVIP vision plan is nationwide and priced the same wherever you live, so this one comes down to premium and what each plan covers.',
      stats: [
        { value: '10', label: 'vision plan options' },
        { value: '5', label: 'carriers' },
        { value: 'None', label: 'ZIP code needed' },
      ],
    },
  }[coverageType];

  return (
    <section className="fehb-hero">
      <div className="fehb-hero-inner">
        <div className="fehb-eyebrow">{content.eyebrow}</div>
        <h1>{content.headline}</h1>
        <p className="fehb-hero-sub">{content.copy}</p>
        <p className="fehb-hero-scope">
          Built for active federal employees, using the employee share of premiums across 26 pay
          periods. Postal employees and annuitants are enrolled under different programs and rate
          schedules and are not covered here.
        </p>
        <div className="fehb-stats">
          {content.stats.map((st, i) => (
            <div className="fehb-stat" key={i}>
              <div className="fehb-stat-v">{st.value}</div>
              <div className="fehb-stat-l">{st.label}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function TabLink({ active, onClick, label, program }) {
  return (
    <button className="fehb-tab" data-active={active} onClick={onClick}>
      {label}<span className="fehb-tab-sub">{program}</span>
    </button>
  );
}

function ViewToggle({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      flex: 1, padding: '9px', fontSize: '0.8rem', fontWeight: 600, borderRadius: 7, cursor: 'pointer',
      border: `1px solid ${active ? COLORS.navy : COLORS.rule}`,
      background: active ? COLORS.navy : COLORS.white,
      color: active ? COLORS.white : COLORS.inkSoft,
      fontFamily: FONT_SANS,
    }}>
      {children}
    </button>
  );
}

function NetworkChip({ breadth }) {
  const styles = {
    broad: { bg: COLORS.goodBg, fg: COLORS.good, text: 'Nationwide' },
    moderate: { bg: COLORS.warnBg, fg: COLORS.warn, text: 'Regional' },
    restrictive: { bg: COLORS.badBg, fg: COLORS.bad, text: 'Local (HMO)' },
  }[breadth.level];
  return (
    <span style={{
      display: 'inline-block', fontSize: '0.7rem', fontWeight: 600, padding: '2px 8px',
      borderRadius: 10, background: styles.bg, color: styles.fg, fontFamily: FONT_SANS,
    }}>
      {styles.text}
    </span>
  );
}

function VisionPlanCard({ plan, idx }) {
  const isBest = idx === 0;
  return (
    <div className="fehb-card" style={{
      animationDelay: `${Math.min(idx * 40, 200)}ms`,
      background: COLORS.white,
      border: '1px solid transparent',
      borderRadius: 16, padding: '22px 22px 20px', marginBottom: 16,
      boxShadow: isBest ? SHADOW_BEST : SHADOW_CARD,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
        <div>
          {isBest && (
            <div style={{
              fontFamily: FONT_MONO, fontSize: '0.66rem', fontWeight: 600, color: COLORS.rust,
              letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 5,
            }}>
              Lowest premium
            </div>
          )}
          <div style={{ fontFamily: FONT_SERIF, fontWeight: 700, fontSize: '1.12rem', color: COLORS.ink, lineHeight: 1.2 }}>
            {plan.carrierName}
          </div>
          <div style={{ color: COLORS.inkSoft, fontSize: '0.84rem', marginTop: 2 }}>
            {plan.planOption} Option
          </div>
        </div>
      </div>

      <div style={{ fontSize: '0.83rem', color: COLORS.ink, marginBottom: 14, lineHeight: 1.5 }}>
        {plan.copaySummary && <div><strong>{plan.copaySummary}</strong></div>}
        {plan.examCoverage && <div style={{ marginTop: 4, color: COLORS.inkSoft }}>Exam: {plan.examCoverage}</div>}
        {plan.framesCoverage && <div style={{ color: COLORS.inkSoft }}>Frames/lenses: {plan.framesCoverage}</div>}
      </div>

      <div style={{ borderTop: `1px solid ${COLORS.rule}`, paddingTop: 4 }}>
        <LedgerLine label="Annual premium (your share)" value={fmt(plan.annualPremium)} />
      </div>

      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        marginTop: 8, paddingTop: 10, borderTop: `1px solid ${COLORS.ink}`,
      }}>
        <span style={{ fontWeight: 600, fontSize: '0.88rem', fontFamily: FONT_SANS, color: COLORS.ink }}>
          Annual premium
        </span>
        <span className="fehb-num" style={{ fontWeight: 700, fontSize: '1.4rem', color: COLORS.navy }}>
          {fmt(plan.annualPremium)}
        </span>
      </div>

      {plan.additionalFeatures && (
        <div style={{ marginTop: 10, fontSize: '0.78rem', color: COLORS.inkSoft, lineHeight: 1.4 }}>
          Also includes: {plan.additionalFeatures}
        </div>
      )}

      {plan.providerDirectoryUrl && (
        <div style={{ marginTop: 10, fontSize: '0.78rem' }}>
          <a href={plan.providerDirectoryUrl} target="_blank" rel="noreferrer" style={{ color: COLORS.navy, fontWeight: 600, textDecoration: 'underline' }}>
            Find an eye doctor in this plan's network &rarr;
          </a>
        </div>
      )}
    </div>
  );
}

function DentalPlanCard({ plan, idx, scaleMax }) {
  const isBest = idx === 0;
  return (
    <div className="fehb-card" style={{
      animationDelay: `${Math.min(idx * 40, 200)}ms`,
      background: COLORS.white,
      border: '1px solid transparent',
      borderRadius: 16, padding: '22px 22px 20px', marginBottom: 16,
      boxShadow: isBest ? SHADOW_BEST : SHADOW_CARD,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
        <div>
          {isBest && (
            <div style={{
              display: 'inline-block', fontFamily: FONT_MONO, fontSize: '0.63rem', fontWeight: 600,
              color: COLORS.white, background: COLORS.rust, padding: '3px 8px', borderRadius: 5,
              letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 8,
            }}>
              Lowest premium + copays
            </div>
          )}
          <div style={{ fontFamily: FONT_SERIF, fontWeight: 700, fontSize: '1.12rem', color: COLORS.ink, lineHeight: 1.2 }}>
            {plan.carrierName}
          </div>
          <div style={{ color: COLORS.inkSoft, fontSize: '0.84rem', marginTop: 2 }}>
            {plan.planOption} Option{!plan.isNationwide && ' · Regional plan'}
          </div>
        </div>
      </div>

      <div style={{ fontSize: '0.83rem', color: COLORS.ink, marginBottom: 14, lineHeight: 1.5 }}>
        Preventive care (checkups, cleanings) is covered at{' '}
        <strong>{plan.preventiveCoverage === '0% Coinsurance' ? 'no cost to you' : (plan.preventiveCoverage || 'an unspecified rate')}</strong>.
        Major work like crowns or root canals is covered at{' '}
        <strong>{plan.majorCoverage ? `${100 - Math.round(parseCoinsurance(plan.majorCoverage) * 100)}%` : 'an unspecified rate'}</strong>, with you paying the rest as coinsurance.
      </div>

      <div style={{ borderTop: `1px solid ${COLORS.rule}`, paddingTop: 4 }}>
        <LedgerLine label="Annual premium (your share)" value={fmt(plan.annualPremium)} />
        <LedgerLine label="Deductible" value={fmt(plan.deductible)} />
        <LedgerLine label="Annual maximum benefit"
          value={plan.annualMaxUnlimited ? 'No annual limit' : fmt(plan.annualMax)} />
        <LedgerLine label="Estimated out-of-pocket (beyond premium)" value={fmt(plan.estimatedOutOfPocket)} />
      </div>

      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        marginTop: 8, paddingTop: 10, borderTop: `1px solid ${COLORS.ink}`,
      }}>
        <span style={{ fontWeight: 600, fontSize: '0.88rem', fontFamily: FONT_SANS, color: COLORS.ink }}>
          Premium + estimated copays
        </span>
        <span className="fehb-num" style={{ fontWeight: 700, fontSize: '1.55rem', color: isBest ? COLORS.rust : COLORS.navy, letterSpacing: '-0.035em' }}>
          {fmt(plan.grandTotal)}
        </span>
      </div>

      <CostBar
        premium={plan.annualPremium}
        copays={plan.estimatedOutOfPocket}
        scaleMax={scaleMax}
        copayLabel="Estimated out-of-pocket"
      />

      {plan.providerDirectoryUrl && (
        <div style={{ marginTop: 10, fontSize: '0.78rem' }}>
          <a href={plan.providerDirectoryUrl} target="_blank" rel="noreferrer" style={{ color: COLORS.navy, fontWeight: 600, textDecoration: 'underline' }}>
            Find a dentist in this plan's network &rarr;
          </a>
        </div>
      )}
    </div>
  );
}

// The one piece of chrome that is not a number or a rule. Each plan's bar is scaled
// against the most expensive plan in the same result set, so the bars are comparable
// across cards: you can see the gap between plans without reading two figures and
// subtracting. Split shows what you pay no matter what (premium) against what depends
// on how much care you use (copays) - the distinction that actually drives the choice.
function CostBar({ premium, copays, scaleMax, copayLabel = 'Estimated copays' }) {
  const total = (premium || 0) + (copays || 0);
  if (!scaleMax || !total) return null;
  const widthPct = Math.max(6, (total / scaleMax) * 100);
  const premiumShare = (premium / total) * 100;

  return (
    <div style={{ marginTop: 12 }}>
      <div className="fehb-bar" style={{ width: `${widthPct}%` }}>
        <i style={{ width: `${premiumShare}%`, background: COLORS.navy }} />
        <i style={{ width: `${100 - premiumShare}%`, background: COLORS.rust }} />
      </div>
      <div style={{ display: 'flex', gap: 14, marginTop: 7, fontSize: '0.7rem', color: COLORS.inkSoft }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: COLORS.navy, display: 'inline-block' }} />
          Premium
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: COLORS.rust, display: 'inline-block' }} />
          {copayLabel}
        </span>
      </div>
    </div>
  );
}

function PlanCard({ plan, idx, enrollmentType, drugsInput, scaleMax }) {
  const [showDrugs, setShowDrugs] = useState(false);
  const isBest = idx === 0;

  return (
    <div className="fehb-card" style={{
      animationDelay: `${Math.min(idx * 40, 200)}ms`,
      background: COLORS.white,
      border: '1px solid transparent',
      borderRadius: 16, padding: '22px 22px 20px', marginBottom: 16,
      boxShadow: isBest ? SHADOW_BEST : SHADOW_CARD,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
        <div>
          {isBest && (
            <div style={{
              display: 'inline-block', fontFamily: FONT_MONO, fontSize: '0.63rem', fontWeight: 600,
              color: COLORS.white, background: COLORS.rust, padding: '3px 8px', borderRadius: 5,
              letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 8,
            }}>
              Cheapest in a typical year
            </div>
          )}
          <div style={{ fontFamily: FONT_SERIF, fontWeight: 700, fontSize: '1.12rem', color: COLORS.ink, lineHeight: 1.2 }}>
            {plan.planOptionName}
          </div>
          <div style={{ color: COLORS.inkSoft, fontSize: '0.84rem', marginTop: 2 }}>
            {plan.carrierName}
          </div>
        </div>
        <FormTag title="Enrollment code for the coverage level you selected">{plan.enrollmentCode}</FormTag>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 11, flexWrap: 'wrap' }}>
        <NetworkChip breadth={plan.networkBreadth} />
        {DISCONTINUED_2027.has(plan.planCode) && (
          <span style={{
            fontSize: '0.7rem', fontWeight: 700, color: COLORS.white, background: '#9B2C2C',
            padding: '3px 8px', borderRadius: 5,
          }}>
            Not offered in 2027
          </span>
        )}
        {plan.deductible != null && plan.deductible >= 1500 && (
          <span style={{
            fontSize: '0.7rem', fontWeight: 600, color: COLORS.warn, background: COLORS.warnBg,
            padding: '3px 8px', borderRadius: 5,
          }}>
            High deductible &middot; {fmt(plan.deductible)} before full coverage
          </span>
        )}
      </div>

      <div style={{ fontSize: '0.83rem', color: COLORS.ink, marginBottom: 14, lineHeight: 1.5 }}>
        {planSummary({ network_type: plan.networkType, [ENROLLMENT_DEDUCTIBLE_FIELD[enrollmentType]]: plan.deductible }, enrollmentType)}{' '}
        <span style={{ color: COLORS.inkSoft }}>{plan.networkBreadth.detail}</span>
      </div>

      <div style={{ borderTop: `1px solid ${COLORS.rule}`, paddingTop: 4 }}>
        <LedgerLine label="Annual premium (your share)" value={fmt(plan.annualPremium)} />
        <LedgerLine label="Estimated visit costs" value={fmt(plan.visitCosts)} />
        {drugsInput.trim() && <LedgerLine label="Estimated drug costs" value={fmt(plan.drugCost)} />}
        <LedgerLine label="Deductible" value={fmt(plan.deductible)} />
        <LedgerLine label="Out-of-pocket maximum" value={fmt(plan.oopMax)} />
      </div>

      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        marginTop: 8, paddingTop: 10, borderTop: `1px solid ${COLORS.ink}`,
      }}>
        <span style={{ fontWeight: 600, fontSize: '0.88rem', fontFamily: FONT_SANS, color: COLORS.ink }}>
          Typical year
        </span>
        <span className="fehb-num" style={{ fontWeight: 700, fontSize: '1.55rem', color: isBest ? COLORS.rust : COLORS.navy, letterSpacing: '-0.035em' }}>
          {fmt(plan.grandTotal)}
        </span>
      </div>

      <CostBar
        premium={plan.annualPremium}
        copays={(plan.visitCosts || 0) + (plan.drugCost || 0)}
        scaleMax={scaleMax}
      />

      {plan.oopMax != null && (
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
          marginTop: 12, paddingTop: 10, borderTop: `1px dashed ${COLORS.rule}`,
        }}>
          <span style={{ fontSize: '0.83rem', color: COLORS.inkSoft }}>
            Most you could pay
            <span style={{ display: 'block', fontSize: '0.72rem', marginTop: 1 }}>
              Premium + this plan's out-of-pocket maximum
            </span>
          </span>
          <span className="fehb-num" style={{ fontWeight: 600, fontSize: '1.05rem', color: COLORS.inkSoft }}>
            {fmt((plan.annualPremium || 0) + plan.oopMax)}
          </span>
        </div>
      )}

      {drugsInput.trim() && plan.drugBreakdown.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <button onClick={() => setShowDrugs(!showDrugs)} style={{
            background: 'none', border: 'none', color: COLORS.navy, fontSize: '0.8rem',
            fontWeight: 600, cursor: 'pointer', padding: 0, fontFamily: FONT_SANS,
          }}>
            {showDrugs ? 'Hide' : 'Show'} drug cost details
          </button>
          {showDrugs && (
            <div style={{ marginTop: 8, fontSize: '0.82rem' }}>
              {plan.drugBreakdown.map((d, i) => (
                <div key={i} style={{
                  display: 'flex', justifyContent: 'space-between', padding: '4px 0',
                  borderBottom: i < plan.drugBreakdown.length - 1 ? `1px dashed ${COLORS.rule}` : 'none',
                }}>
                  <span style={{ color: COLORS.ink }}>{d.drug}</span>
                  {d.status === 'estimated' && (
                    <span className="fehb-num" style={{ color: COLORS.good, fontWeight: 600 }}>
                      Tier {d.tier} &middot; {fmt(d.annualCost)}/yr
                    </span>
                  )}
                  {d.status === 'not_covered_on_this_plan' && <span style={{ color: COLORS.inkSoft }}>Not covered</span>}
                  {d.status === 'no_formulary_data_for_this_plan' && <span style={{ color: COLORS.inkSoft }}>Unknown — check formulary</span>}
                  {d.status === 'tier_cost_unparseable' && <span style={{ color: COLORS.inkSoft }}>Unknown</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {plan.hasUnknownDrugCosts && (
        <div style={{
          marginTop: 11, fontSize: '0.78rem', color: COLORS.warn, background: COLORS.warnBg,
          border: `1px solid ${COLORS.warn}33`, padding: '8px 10px', borderRadius: 6, lineHeight: 1.45,
        }}>
          Formulary data isn't available yet for one or more of your medications on this plan.{' '}
          {plan.formularyUrl && (
            <a href={plan.formularyUrl.startsWith('http') ? plan.formularyUrl : `https://${plan.formularyUrl}`}
               target="_blank" rel="noreferrer" style={{ color: COLORS.warn, fontWeight: 600, textDecoration: 'underline' }}>
              Check this plan's formulary directly &rarr;
            </a>
          )}
        </div>
      )}
    </div>
  );
}

function LedgerLine({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', fontSize: '0.86rem' }}>
      <span style={{ color: COLORS.inkSoft }}>{label}</span>
      <span className="fehb-num" style={{ fontWeight: 600, color: COLORS.ink }}>{value}</span>
    </div>
  );
}

function LedgerTable({ results, enrollmentType, drugsInput }) {
  return (
    <div style={{
      overflowX: 'auto', background: COLORS.white, border: `1px solid ${COLORS.rule}`,
      borderRadius: 8, marginBottom: 18,
    }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem', minWidth: 520, fontFamily: FONT_SANS }}>
        <thead>
          <tr style={{ borderBottom: `2px solid ${COLORS.ink}` }}>
            <th style={thStyle('left', true)}>Plan</th>
            <th style={thStyle('left')}>Network</th>
            <th style={thStyle('right')}>Premium</th>
            <th style={thStyle('right')}>Deductible</th>
            <th style={thStyle('right')}>OOP max</th>
            {drugsInput.trim() && <th style={thStyle('right')}>Drugs</th>}
            <th style={thStyle('right')}>Typical year</th>
            <th style={thStyle('right')}>Most you could pay</th>
          </tr>
        </thead>
        <tbody>
          {results.map((plan, idx) => (
            <tr key={plan.planCode} style={{
              borderBottom: `1px solid ${COLORS.rule}`,
              background: idx === 0 ? COLORS.paperDeep : 'transparent',
            }}>
              <td style={tdStyle('left', true, idx === 0)}>
                <div style={{ fontWeight: 600, color: COLORS.ink, fontFamily: FONT_SERIF }}>{plan.planOptionName}</div>
                <div style={{ color: COLORS.inkSoft, fontSize: '0.72rem' }}>{plan.carrierName}</div>
              </td>
              <td style={tdStyle('left')}><NetworkChip breadth={plan.networkBreadth} /></td>
              <td className="fehb-num" style={tdStyle('right')}>{fmt(plan.annualPremium)}</td>
              <td className="fehb-num" style={tdStyle('right')}>{fmt(plan.deductible)}</td>
              <td className="fehb-num" style={tdStyle('right')}>{fmt(plan.oopMax)}</td>
              {drugsInput.trim() && <td className="fehb-num" style={tdStyle('right')}>{fmt(plan.drugCost)}</td>}
              <td className="fehb-num" style={{ ...tdStyle('right'), fontWeight: 700, color: COLORS.navy, fontSize: '0.92rem' }}>
                {fmt(plan.grandTotal)}
              </td>
              <td className="fehb-num" style={{ ...tdStyle('right'), color: COLORS.inkSoft }}>
                {plan.oopMax != null ? fmt((plan.annualPremium || 0) + plan.oopMax) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function thStyle(align, sticky) {
  return {
    textAlign: align, padding: sticky ? '10px 12px' : '10px 8px', fontWeight: 600,
    color: COLORS.ink, position: sticky ? 'sticky' : 'static', left: sticky ? 0 : 'auto',
    background: sticky ? COLORS.white : 'transparent',
  };
}

function tdStyle(align, sticky, isBest) {
  return {
    textAlign: align, padding: sticky ? '10px 12px' : '10px 8px',
    position: sticky ? 'sticky' : 'static', left: sticky ? 0 : 'auto',
    background: sticky ? (isBest ? COLORS.paperDeep : COLORS.white) : 'transparent',
  };
}


// Test-only export: lets the build-time checks exercise the pricing functions.
export const __test = { comparePlans, compareDentalPlans, compareVisionPlans, estimateDrugCost, parseCostShare };
