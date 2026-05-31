# OpenConstruction — how this build addresses the four questions

This is the **real OpenConstruction site** (`ruoxinx/open-construction`, `site/`) extended
in place — same look, same `data/*.json`, same GitHub-as-source-of-truth model — with
demos that answer all four of the PI's open questions. Everything is **client-side and
static**, so it stays cheap to host and easy to maintain (the PI's sustainability point).

| Q | Question | What was added | Files |
|---|---|---|---|
| **Q1** | Usability / contributor portal | A **no-Git guided wizard** on `contribute.html`: pick type → guided form → live JSON preview → schema validation → "Open Pull Request" (via a GitHub App, demo). Plus a "Sign in with GitHub" affordance. | `assets/js/contribute-wizard.js` |
| **Q2** | AI / MCP assistant search | An **"Ask the assistant"** mode added to the existing hero search bar. Natural-language → grounded, **citation-based** recommendations across all catalogs. Cross-recommends bundles (e.g. a skill + its related dataset/model). | `assets/js/assistant.js`, `assets/css/assistant.css` |
| **Q3** | Closing the last mile | A **"Work with this resource"** action bar on dataset/model detail pages: *Open in Colab* starter notebook, in-browser **IFC / point-cloud preview**, and one-click **Cite** (BibTeX). No data hosting required. | `assets/js/lastmile.js` |
| **Q4** | AEC skill catalog | A new **Skills catalog** (`skills.html`) of `SKILL.md` packages, filterable by domain × phase × discipline × software × AI target, with an install UX (Claude / CLI / manual). Wired into the assistant search too. | `skills.html`, `assets/js/skills.js`, `data/skills.json` |

Only **2 lines** were added to `index.html` (the assistant CSS + JS); `contribute.html`
and the two detail pages each got **1 script tag**; a **Skills** link was added to the
shared nav. Nothing else in the original site was modified.

## Why this is the sustainable answer (the PI's main concern)

The assistant's retrieval runs **100% in the browser** — no server, no database, no LLM
API call, so **$0 marginal cost per query** at any traffic level. Because every answer is
copied from a real catalog field (title, authors, year, DOI, license), it **cannot
hallucinate a citation**; when nothing matches it says so.

### Chatbot cost: light / moderate / heavy

| Usage | Queries/mo | This build (client-side) | If we hosted an LLM chatbot instead |
|---|---|---|---|
| Light | ~1k | **$0** | ~$5–30/mo |
| Moderate | ~20k | **$0** | ~$100–600/mo |
| Heavy | ~200k+ | **$0** (scales free on CDN) | ~$1k–6k/mo — the most variable line |

If conversational phrasing is wanted later, the *same* retrieval can feed an LLM, kept
cheap via **prompt caching**, **rate limits**, **smaller/open models**, and
**bring-your-own-key through MCP** (the user's own Claude does the talking — $0 to us).
That path is surfaced by the assistant footer's *"Connect your own Claude via MCP →"*.

## Run locally

```bash
cd OpenConstruction
python3 -m http.server 8000
# Home → "Ask the assistant"   |   Skills (nav)   |   Contribute → no-Git wizard
# Any dataset/model detail page → "Work with this resource"
```

Pure static files — deploy the folder as-is. The features only need `data/*.json` served
alongside (they are).
