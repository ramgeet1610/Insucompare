# Annual data refresh

The site's `public/data/*.json` files are generated from OPM's Public Use Files.
Refreshing them for a new plan year is one script run plus three small edits.

## 1. Download the PUFs

From <https://www.opm.gov/healthcare-insurance/healthcare/transparency-in-healthcare/public-use-files/>,
take these nine files for the new plan year (skip the PSHB set — this site is for
non-postal employees):

    <year>-fehb-plan-key_*.xlsx
    <year>-fehb-rates_*.xlsx
    <year>-fehb-plan-benefits_*.xlsx
    <year>-fehb-service-area_*.xlsx
    <year>-fedvip-plan-key_*.xlsx
    <year>-fedvip-rates_*.xlsx
    <year>-fedvip-benefits_*.xlsx
    <year>-fedvip-zipcodes_*.xlsx
    <year>-dental-rating-region_*.xlsx   (optional — regions also live in the zipcodes file)

OPM re-dates files during Open Season, so the date suffixes change. The script
matches on the stem, not the full name.

## 2. Run the converter

    pip install openpyxl
    python tools/convert_opm_puf.py <raw-dir> <out-dir> public/data

`<raw-dir>` holds the downloaded xlsx files; `<out-dir>` receives the JSON. It
asserts on every join, so a silent mismatch fails loudly rather than shipping
wrong premiums. Copy the output over `public/data/` when it passes.

`medical_zip_info.json` is NOT regenerated — it is SimpleMaps ZIP→county data,
not OPM's, and does not change with the plan year.

## 3. Edit three things in `src/FEHBComparison.jsx`

    DATA_PLAN_YEAR        -> the new plan year
    CURRENT_SHOPPING_YEAR -> the year people are shopping for
    OPEN_SEASON_TEXT      -> the new Open Season dates

When those first two match, the red stale-data warning turns into the calm
Open Season bar automatically. Also update the three hero stats (plan options,
carriers, plans with drug data) — the converter prints all three.

## 4. The formulary is not in the PUFs

`public/data/formulary.json` maps drug name → plan code → tier. OPM publishes
what each TIER costs, never which tier a given drug sits in, so that mapping was
researched by hand from carrier formularies. The converter prunes entries for
plans that no longer exist, but it cannot re-verify tier placement. Until it is
re-checked against the new year's carrier formularies, the warning under the
medications field must stay.
