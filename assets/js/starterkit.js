// Copyright (c) 2024-2026 OpenConstruction Open Science Initiative
// SPDX-License-Identifier: Apache-2.0
//
// starterkit.js — OCStarterKit: the Use-stage generator (Phase-C component #3).
// OpenConstruction indexes rather than hosts, so "use" = generate a runnable starter notebook the user
// opens in Colab / on their own machine. NOTHING is trained on our server. The notebook is a SCAFFOLD:
// the load/baseline code is template code, but every DATASET DATUM embedded in it (id, access URL,
// license, modality, task, classes) is read from the real catalog record — never invented.
//
// HARD RULE (research integrity): scaffold code (load/baseline templates) is legitimate boilerplate and is
// labelled as such. But any dataset-specific value (url / license / modality / counts) MUST come from the
// record; if a field is missing we emit `# TODO: verify` / "not specified" rather than a fabricated value.
// No fake training results are embedded.
//
// API:
//   OCStarterKit.build(record, needOrTask) -> { nbJson, nbString, filename, notes }
//   OCStarterKit.download(record, needOrTask)  -> triggers a client-side .ipynb download (Blob)

(function () {
  'use strict';
  var W = (typeof window !== 'undefined') ? window : null;
  function eng() { return W && W.OCDataAgent ? W.OCDataAgent : null; }

  function taskOf(needOrTask) {
    if (!needOrTask) return '';
    if (typeof needOrTask === 'string') return needOrTask;
    return needOrTask.task || '';
  }
  function safeId(s) { return String(s == null ? 'dataset' : s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'dataset'; }
  function pyStr(v) { // emit a safe Python string literal, or None when truly absent (never invent)
    if (v == null || v === '' ) return 'None';
    return JSON.stringify(String(v)); // JSON string == valid Python str literal
  }

  function modalityKind(rec) {
    var hay = ((rec.modality || []).join(' ') + ' ' + (rec.modalityRaw || '')).toLowerCase();
    if (/point[\s_-]*cloud|lidar|\.las|\.laz|\.ply|\.pcd|e57/.test(hay)) return 'point_cloud';
    if (/\bbim\b|ifc/.test(hay)) return 'bim';
    if (/video|temporal|tracking/.test(hay)) return 'video';
    if (/tabular|table|csv|sensor|timeseries|time[\s_-]*series/.test(hay)) return 'tabular';
    if (/image|rgb|photo|visual|depth|thermal/.test(hay)) return 'image';
    if (/text|caption|document/.test(hay)) return 'text';
    return 'unknown';
  }
  function taskKind(task) {
    var t = (task || '').toLowerCase();
    if (/detection|detect|bounding/.test(t)) return 'detection';
    if (/segment/.test(t)) return 'segmentation';
    if (/track/.test(t)) return 'tracking';
    if (/classif|recogni/.test(t)) return 'classification';
    return 'generic';
  }

  // ---- cell builders (nbformat-4) ----
  function lines(arr) { return arr.map(function (l, i) { return i < arr.length - 1 ? l + '\n' : l; }); }
  function md(arr) { return { cell_type: 'markdown', metadata: {}, source: lines(arr) }; }
  function code(arr) { return { cell_type: 'code', metadata: {}, execution_count: null, outputs: [], source: lines(arr) }; }

  function loadCell(kind, accessKnown) {
    var dl = accessKnown
      ? ['# Download (only if ACCESS_URL is a direct file/repo URL; respect the license above)',
         'import os, urllib.request', 'os.makedirs("data", exist_ok=True)',
         'if ACCESS_URL: print("Fetch from:", ACCESS_URL)  # urllib.request.urlretrieve(ACCESS_URL, "data/raw")']
      : ['# No direct access URL in the catalog metadata — open the resource page to get the data.',
         '# TODO: verify the access path before downloading.'];
    var body = {
      image: ['# Load + preview (image dataset) — SCAFFOLD, adjust paths to your download', 'from glob import glob',
              'imgs = glob("data/**/*.jpg", recursive=True) + glob("data/**/*.png", recursive=True)',
              'print("images found:", len(imgs))', '# from PIL import Image; Image.open(imgs[0]) if imgs else None'],
      tabular: ['# Load + profile (tabular) — SCAFFOLD', 'import pandas as pd, glob',
                'csvs = glob.glob("data/**/*.csv", recursive=True)',
                'df = pd.read_csv(csvs[0]) if csvs else None', 'print(df.shape if df is not None else "no csv yet")',
                '# df.describe(include="all")'],
      point_cloud: ['# Load (point cloud) — SCAFFOLD (needs open3d / laspy depending on format)',
                    '# import open3d as o3d; pcd = o3d.io.read_point_cloud("data/sample.ply"); print(pcd)',
                    'print("point-cloud loaders: open3d (.ply/.pcd), laspy (.las/.laz)")'],
      bim: ['# Load (BIM / IFC) — SCAFFOLD with IfcOpenShell (no BIM software needed)',
            '# import ifcopenshell; m = ifcopenshell.open("data/model.ifc")',
            '# print({e: len(m.by_type(e)) for e in ["IfcWall","IfcSlab","IfcDoor"]})',
            'print("IFC parsing: pip install ifcopenshell")'],
      video: ['# Load (video) — SCAFFOLD', '# import cv2; cap = cv2.VideoCapture("data/clip.mp4")',
              '# print(cap.get(cv2.CAP_PROP_FRAME_COUNT))', 'print("video loaders: opencv / decord")'],
      text: ['# Load (text/document) — SCAFFOLD', 'from glob import glob', 'docs = glob("data/**/*.txt", recursive=True)',
             'print("documents found:", len(docs))'],
      unknown: ['# Modality not declared in metadata — inspect the files first.', '# TODO: verify modality, then pick a loader.']
    };
    return code(dl.concat(['']).concat(body[kind] || body.unknown));
  }

  function baselineCell(tk) {
    var map = {
      detection: ['# Baseline scaffold — object detection (e.g. ultralytics YOLO). NOT run here.',
                  '# pip install ultralytics ; from ultralytics import YOLO',
                  '# model = YOLO("yolo11n.pt"); model.train(data="data.yaml", epochs=10)  # run on Colab/your machine'],
      segmentation: ['# Baseline scaffold — segmentation. NOT run here.',
                     '# e.g. ultralytics YOLO-seg or torchvision deeplabv3; train on Colab/your machine'],
      tracking: ['# Baseline scaffold — tracking. NOT run here.',
                 '# e.g. ByteTrack / a detector + tracker; train/eval on Colab/your machine'],
      classification: ['# Baseline scaffold — classification. NOT run here.',
                       '# e.g. torchvision resnet18 finetune; train on Colab/your machine'],
      generic: ['# Baseline scaffold — pick a model for TASK above. NOT run here.',
                '# This notebook prepares data + config only; training runs on Colab/your machine ($0 hosting).']
    };
    return code(['# === Baseline (readiness, not a server training run) ==='].concat(map[tk] || map.generic));
  }

  function readinessCell(rec, kind) {
    var base = ['# Readiness check (metadata-level; verify against the real files once downloaded)',
      'checks = {',
      '    "has_access_url": ACCESS_URL is not None,',
      '    "declared_annotations": bool(ANNOTATIONS),',
      '    "declared_classes": NUM_CLASSES,  # None if not in metadata',
      '    "commercial_use_ok": COMMERCIAL_OK,  # None = unknown',
      '}',
      'for k, v in checks.items(): print(f"{k}: {v}")'];
    if (kind === 'bim') {
      base = base.concat(['',
        '# AEC/BIM readiness barriers (Du et al. 2024) — metadata cannot confirm these; check the IFC:',
        '#   1) IFC time-series support (scheduling/sensor) — often absent',
        '#   2) geometric-information extraction — verify geometry present',
        '#   3) IFC -> AI-format toolchain — you must build it (IfcOpenShell -> features)']);
    }
    return code(base);
  }

  // ---------------------------------------------------------------- build
  function build(record, needOrTask) {
    var A = eng();
    var rec = record || {};
    var task = taskOf(needOrTask);
    var kind = modalityKind(rec);
    var tk = taskKind(task);

    var accessUrl = rec.access || null;
    var urlInfo = (accessUrl && A && A.classifyUrl) ? A.classifyUrl(accessUrl) : null;
    var accessKnown = !!(urlInfo && (urlInfo.access_class === 'open'));
    var cls = rec.licenseClass || (A && A.licenseClass ? A.licenseClass(rec.license) : 'unknown');
    var commercialOk = rec.rights ? rec.rights.commercial_ok : (A && A.licenseRights ? A.licenseRights(rec.license).commercial_ok : null);
    var cite = (A && A.citation) ? A.citation(rec) : null;
    var modalityTxt = rec.modalityRaw || ((rec.modality || []).join(', ')) || 'not specified';
    var annTxt = (rec.annotationRaw && rec.annotationRaw.length) ? rec.annotationRaw.join(', ') : 'not specified';

    var headerMd = md([
      '# OpenConstruction — starter notebook',
      '', '**Dataset:** ' + (rec.name || rec.id || 'Untitled') + '  ',
      '**ID:** `' + (rec.id || 'n/a') + '`  ',
      '**Task (your goal):** ' + (task || '_unspecified_') + '  ',
      '**Modality (metadata):** ' + modalityTxt + '  ',
      '**Annotations (metadata):** ' + annTxt + '  ',
      '**License:** ' + (rec.license || 'Not specified') + ' (' + cls + ', commercial_ok=' + String(commercialOk) + ')  ',
      '**Access:** ' + (accessUrl || '_not specified — see the resource page_') +
        (urlInfo ? '  _(' + urlInfo.repository + ' · ' + urlInfo.access_class + ')_' : '') + '  ',
      (cite && cite.text ? '**Cite:** ' + cite.text : '**Cite:** _authors not in metadata_'),
      '', '> OpenConstruction indexes resources rather than hosting them. This notebook scaffolds load → preview →',
      '> baseline-config → readiness. It does **not** train on a server; run training in Colab / on your machine.',
      '> Code below is a template; every dataset value above is read from the catalog record (missing → "not specified").'
    ]);

    var licenseMd = md([
      '## License & usage', '',
      '- License: **' + (rec.license || 'Not specified') + '** — class `' + cls + '`, commercial_ok = `' + String(commercialOk) + '`.',
      (commercialOk === false
        ? '- ⚠️ **Non-commercial / restricted** per metadata — do not use for commercial deployment without checking the original terms.'
        : (commercialOk === true ? '- Commercial use appears allowed by the license class — still verify the original terms.'
          : '- ⚠️ License terms unknown — **verify on the source page before any reuse**.'))
    ]);

    var configCell = code([
      '# === Dataset metadata (read from the OpenConstruction catalog — verify before relying on it) ===',
      'DATASET_ID   = ' + pyStr(rec.id),
      'DATASET_NAME = ' + pyStr(rec.name),
      'TASK         = ' + pyStr(task) + '   # your stated goal',
      'MODALITY     = ' + pyStr(rec.modalityRaw || (rec.modality || []).join(', ')),
      'ANNOTATIONS  = ' + pyStr((rec.annotationRaw || []).join(', ')),
      'LICENSE      = ' + pyStr(rec.license) + '   # commercial_ok=' + String(commercialOk),
      'COMMERCIAL_OK = ' + (commercialOk === true ? 'True' : (commercialOk === false ? 'False' : 'None')),
      'NUM_CLASSES  = ' + (rec.numClasses != null ? String(rec.numClasses) : 'None') + '   # None = not in metadata',
      'NUM_IMAGES   = ' + (rec.numImages != null ? String(rec.numImages) : 'None') + '   # None = not in metadata',
      'ACCESS_URL   = ' + pyStr(accessUrl) + (accessUrl ? '' : '   # TODO: verify — no access URL in metadata')
    ]);

    var cells = [headerMd, licenseMd, configCell, loadCell(kind, accessKnown), baselineCell(tk), readinessCell(rec, kind),
      md(['---', '_Readiness scaffold — no training was run and no results are pre-filled. ' +
          'Fill in after running on Colab/your machine._'])];

    var nbJson = {
      cells: cells,
      metadata: {
        kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
        language_info: { name: 'python', version: '3.x' },
        openconstruction: { dataset_id: rec.id || null, task: task || null, generated_by: 'OCStarterKit', hosts_data: false, trains_on_server: false }
      },
      nbformat: 4, nbformat_minor: 5
    };
    var filename = 'openconstruction-' + safeId(rec.id || rec.name) + '-starter.ipynb';
    var notes = [];
    if (!accessUrl) notes.push('no access URL in metadata → download cell is a TODO');
    if (commercialOk == null) notes.push('license commercial-use unknown → flagged in the notebook');
    if (kind === 'unknown') notes.push('modality not declared → generic loader');
    return { nbJson: nbJson, nbString: JSON.stringify(nbJson, null, 1), filename: filename, notes: notes };
  }

  function download(record, needOrTask) {
    var out = build(record, needOrTask);
    if (!W || !W.document) return out;
    var blob = new Blob([out.nbString], { type: 'application/x-ipynb+json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = out.filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
    return out;
  }

  var OCStarterKit = { build: build, download: download };
  if (typeof module !== 'undefined' && module.exports) module.exports = OCStarterKit;
  if (W) W.OCStarterKit = OCStarterKit;
})();
