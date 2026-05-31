# OpenConstruction Assistant — what was added & why

This is the **real OpenConstruction site** (cloned from `ruoxinx/open-construction`,
`site/`) with one addition: an **assistant-style layer on top of the existing
hero search bar**. It directly follows the PI's feedback:

> *"extend the current OpenConstruction interface, especially the search bar, with
> chatbot-style or assistant-style functionality … focus first on a lightweight,
> sustainable prototype that extends the existing platform rather than building a
> completely separate system … connect the chatbot/search prototype to the existing
> catalog JSON files and test whether it can return accurate, citation-based resource
> recommendations."*

## What changed (minimal, non-invasive)

| File | Change |
|---|---|
| `assets/js/assistant.js` | **New.** The assistant: loads the same catalog JSON, builds a weighted index, ranks results, renders grounded cards with citations. |
| `assets/css/assistant.css` | **New.** Styling using the site's existing CSS variables (`--oc-*`) so it looks native, not like a separate platform. |
| `index.html` | **2 lines added** — one `<link>` for the CSS, one `<script>` for the JS. The assistant injects a `Search | Ask` toggle into the existing search bar at runtime. |
| `data/*.json` | The real catalog JSON (datasets, models, use-cases, oer, …). |

Nothing else in the site was modified. Toggle to **Search** = the original instant
keyword dropdown, untouched. Toggle to **Ask the assistant** = natural-language query →
ranked, cited recommendations.

## Why this is the *sustainable* answer (the PI's main concern)

Retrieval runs **100% in the browser**. For each query there is:

- **No server call** — the catalog JSON is already static and CDN-cached.
- **No database** — no Supabase/Postgres hit.
- **No LLM API call** — so **$0 marginal cost per query**, at any traffic level.

Because every word in an answer is copied from a real catalog field (title, authors,
year, DOI, license), the assistant **cannot hallucinate a citation**. When nothing
matches, it says so instead of padding with irrelevant cards.

### Cost under light / moderate / heavy usage

| Usage | Queries/mo | This (client-side) | If we added a hosted LLM chatbot instead |
|---|---|---|---|
| Light | ~1k | **$0** | ~$5–30/mo |
| Moderate | ~20k | **$0** | ~$100–600/mo |
| Heavy | ~200k+ | **$0** (scales free on Pages/CDN) | ~$1k–6k/mo, the single most variable line |

The only thing that scales is static-file bandwidth, which the existing host already
serves for free.

### Optional upgrade path (kept cheap)

If conversational phrasing is wanted later, the *same retrieval* feeds an LLM — and
cost stays controllable via: **prompt caching** (ontology/schema are near-constant),
**rate limits** per IP/session, **smaller/open models** for the rewrite step, and
**bring-your-own-key via MCP** (the user's own Claude does the talking — $0 to us).
That's what the footer's *"Connect your own Claude via MCP →"* link points at
(`mcp.html`), so the free client-side baseline and the BYO-key path coexist.

## Run locally

```bash
cd OpenConstruction
python3 -m http.server 8000
# open http://localhost:8000  → try the "Ask the assistant" toggle
```

## Deploy

Pure static files — deploy the contents of this folder to GitHub Pages / Netlify /
the existing host. The assistant needs `data/*.json` to be served alongside (they are).
