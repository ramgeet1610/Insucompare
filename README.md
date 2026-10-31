# FEHB Comparison Tool — Deployment Guide

This is a complete, ready-to-deploy project. Follow these steps exactly to get it live.

## What you'll need first

1. **Node.js installed** on your computer (v18 or newer). Check with `node --version` in a terminal. If you don't have it, download from nodejs.org.
2. **A free Vercel account** (vercel.com) — the easiest host for this kind of project, since it handles both the static site and the chat backend function automatically.

## Step 1: Get this code onto your computer

Download/copy this entire `fehb-deploy` folder to your computer.

## Step 2: Test it locally first (strongly recommended)

Open a terminal in the `fehb-deploy` folder and run:

```
npm install
npm run dev
```

This should print a local URL (usually `http://localhost:5173`). Open it in your browser and click through all three tabs (Medical/Dental/Vision) to confirm everything works. The chat assistant will NOT work yet at this step (it needs the API key set up — see Step 4), but everything else should.

If `npm install` or `npm run dev` give errors, stop here and troubleshoot before continuing — deploying broken code just makes debugging harder.

## Step 3: Push this to GitHub

1. Create a new repository on github.com (can be private).
2. In your terminal, inside the `fehb-deploy` folder:
```
git init
git add .
git commit -m "Initial deploy"
git branch -M main
git remote add origin <your-github-repo-url>
git push -u origin main
```

## Step 4: Deploy to Vercel

1. Go to vercel.com, sign in (you can sign in with your GitHub account directly).
2. Click "Add New Project" and select the GitHub repository you just pushed.
3. Vercel should auto-detect this as a Vite project. Leave the default settings.
4. No environment variables are required.

5. Click **Deploy**.

Vercel will give you a live URL (something like `your-project.vercel.app`) within a minute or two.

## Step 5: Test the live site

Go through all three tabs again on the live URL, 

## Step 6 (optional): Custom domain

In your Vercel project settings → Domains, you can add a custom domain you own (e.g. `fehbworksheet.com`) and follow Vercel's instructions to point your domain's DNS at it.

## Updating the site later

Any time you want to change something (add more drug formulary data, fix a bug, update legal text), edit the files, then:
```
git add .
git commit -m "describe what changed"
git push
```
Vercel automatically redeploys within a minute or two of any push to the main branch.

## What's in this project

- `src/FEHBComparison.jsx` — the entire app: medical/dental/vision comparison tools, chat assistant, legal pages
- `public/data/*.json` — all the FEHB/FEDVIP plan, rate, and formulary data, loaded by the app at runtime
- `public/legal/*.md` — privacy policy and terms of use, loaded by the legal page modals
- `public/favicon.svg`, `public/robots.txt`, `public/sitemap.xml` — site metadata

## A note on the cost estimates

The "premium + estimated copays" figure is exactly that: the employee share of the annual premium
plus a simplified estimate of visit and prescription copays. It deliberately does **not** add the
deductible, cap spending at the out-of-pocket maximum, or credit the HSA/HRA contribution that
high-deductible plans make on the enrollee's behalf. Those omissions push in opposite directions
for high-deductible plans, so those plans do not sort reliably against low-deductible ones. The UI
says so above every result set, and the deductible is shown as its own line on each plan card.

If you later want the totals to be a true annual-cost projection rather than a premium-plus-copay
figure, that means modelling deductible order-of-operations per plan (which services apply before
vs. after the deductible), which is not in the OPM public use files and would have to be sourced
from plan brochures.

## Before telling people this is live

A few things worth doing before real traffic, even though the app itself works:
- Have an actual attorney review the privacy policy, terms of use, and the overall "comparison tool, not insurance advice" positioning — this project's legal docs are a strong starting draft, not a substitute for real legal review.
- Decide on a real domain name and contact email, and fill those into the legal docs (look for `[DATE]`, `[TOOL NAME]`, `[CONTACT EMAIL]` placeholders in `public/legal/*.md`).

- The site is configured for the domain `insucompare.com`. If that ever changes, update it in
  four places: the canonical and Open Graph URLs in `index.html`, `public/robots.txt`, and
  `public/sitemap.xml`.
- The published contact address is `contact@insucompare.com`, set at the bottom of both files
  under `public/legal/`.
