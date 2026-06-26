#!/usr/bin/env python3
# Copyright (c) 2024-2026 OpenConstruction Open Science Initiative
# SPDX-License-Identifier: Apache-2.0
#
# build_dense_cache.py — build ONE reusable dense-retrieval embedding cache for the RAG-dense baseline.
# Embeds the corpus docs + golden-set queries (from a precomputed inputs file, keyed by the SAME docText /
# queryText used by BM25, so the dense and lexical baselines are scored on identical inputs) with the model's
# CORRECT retrieval prefixes, L2-normalized. The cache is model-agnostic and reused forever (no endpoint):
#   { "_meta": {model, revision, dim, n_docs, n_queries, doc_prefix, query_prefix, normalized, device, created},
#     "doc_ids": [...], "doc_vecs": [[...]], "queries": { "<queryText>": [...] } }
# consumed by  node scripts/run_dense_rag.js --cache <cache.json>.
#
# IMPORTANT: pass the prefixes that each model's CARD specifies (they materially affect retrieval quality):
#   nomic-embed-text-v1.5 : --doc-prefix "search_document: " --query-prefix "search_query: "
#   intfloat/e5-*         : --doc-prefix "passage: "         --query-prefix "query: "
#   BAAI/bge-* , mxbai    : --doc-prefix ""  --query-prefix "Represent this sentence for searching relevant passages: "
#   Alibaba-NLP/gte-*-v1.5: --doc-prefix ""  --query-prefix ""   (+ --trust-remote-code)   # per card, no instruction
#
#   python build_dense_cache.py --inputs dense_inputs.json --model-dir <path> --name <id> \
#          --doc-prefix "<>" --query-prefix "<>" --out <cache.json> [--trust-remote-code]

import argparse, json, time, glob


def revision(model_dir):
    """Best-effort: read the pinned commit hash from the hf-download metadata sidecars."""
    for f in sorted(glob.glob(model_dir + "/.cache/huggingface/download/*.metadata")):
        try:
            line = open(f).readline().strip()
            if len(line) >= 20:
                return line
        except Exception:
            pass
    return None


def main():
    ap = argparse.ArgumentParser(description="Build one dense-retrieval embedding cache.")
    ap.add_argument("--inputs", required=True, help="dense_inputs.json {doc_ids, doc_texts, query_texts}")
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--name", required=True, help="model id recorded in the cache _meta")
    ap.add_argument("--out", required=True)
    ap.add_argument("--doc-prefix", default="")
    ap.add_argument("--query-prefix", default="")
    ap.add_argument("--trust-remote-code", action="store_true")
    a = ap.parse_args()

    from sentence_transformers import SentenceTransformer
    inp = json.load(open(a.inputs))
    ids, dtx, qtx = inp["doc_ids"], inp["doc_texts"], inp["query_texts"]
    assert len(ids) == len(dtx), "doc_ids/doc_texts length mismatch"

    t0 = time.time()
    model = SentenceTransformer(a.model_dir, trust_remote_code=a.trust_remote_code)
    dim = int(model.get_sentence_embedding_dimension())
    doc_vecs = model.encode([a.doc_prefix + t for t in dtx], normalize_embeddings=True, batch_size=64)
    qry_vecs = model.encode([a.query_prefix + t for t in qtx], normalize_embeddings=True, batch_size=64)

    rnd = lambda v: [round(float(x), 6) for x in v]
    cache = {
        "_meta": {
            "model": a.name, "revision": revision(a.model_dir), "dim": dim,
            "n_docs": len(ids), "n_queries": len(qtx),
            "doc_prefix": a.doc_prefix, "query_prefix": a.query_prefix,
            "normalized": True, "device": str(model.device),
            "created": time.strftime("%Y-%m-%dT%H:%M:%S"),
        },
        "doc_ids": ids,
        "doc_vecs": [rnd(v) for v in doc_vecs],
        "queries": {q: rnd(qry_vecs[i]) for i, q in enumerate(qtx)},
    }
    json.dump(cache, open(a.out, "w"))
    print("CACHE_OK name=%s dim=%d docs=%d queries=%d doc_prefix=%r query_prefix=%r %.1fs -> %s"
          % (a.name, dim, len(ids), len(qtx), a.doc_prefix, a.query_prefix, time.time() - t0, a.out))


if __name__ == "__main__":
    main()
