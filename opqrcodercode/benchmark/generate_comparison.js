#!/usr/bin/env node
'use strict';
/**
 * OPQR Comparison Methods Generator
 *
 * 先行研究の手法を同一ベンチマーク画像で再現し、OPQR との公平な比較基準を作る。
 *
 * 実装した手法:
 *   standard      - 標準 QR コード（画像なし・ベースライン）
 *   center_logo_s - センターロゴ方式 (15% サイズ, ECL=Q 相当の運用)
 *   center_logo_l - センターロゴ方式 (30% サイズ, ECL=H 推奨)
 *   ecc_overlay   - ECC 消費型オーバーレイ (非構造モジュールを画像で上書き)
 *                   ECL=L/M/Q/H ごとの消費量を記録
 *
 * 使い方:
 *   node generate_comparison.js [options]
 *
 * オプション:
 *   --dataset  <dir>          ベンチマークデータセット (default: ./opqr_benchmark_dataset)
 *   --output   <dir>          出力先 (default: ./opqr_comparison)
 *   --text     <str>          QR に埋め込むテキスト (default: "OPQR code")
 *   --versions <v07,v10,v20>  対象バージョン (default: v07,v10,v20)
 *   --cell     <px>           セルサイズ px (default: 8)
 *   --margin   <cells>        余白セル数 (default: 4)
 */

const fs   = require('fs');
const path = require('path');

const PROJ_ROOT     = path.resolve(__dirname, '../OPQRcode-rn');
const { PNG }       = require(path.join(PROJ_ROOT, 'node_modules/pngjs'));
const qrcodeFactory = require(path.join(PROJ_ROOT, 'src/core/qrcode.js'));

// ── ECC レベル別の理論的エラー訂正率 (ISO/IEC 18004) ──────────────
// 「全モジュール中、何%まで誤り（上書き）を許容するか」の実用的近似値。
// 論文では「ECL=X で Y% の上書きを実施」と記述する。
const ECC_CAPACITY = { L: 0.07, M: 0.15, Q: 0.25, H: 0.30 };

// ── QR バージョン識別子 → 型番 ────────────────────────────────────
const VERSION_MAP = { v07: 45, v10: 57, v20: 97 };
function typeNumberFromVersionId(vid) {
  const size = VERSION_MAP[vid];
  if (!size) throw new Error(`Unknown version: ${vid}`);
  return Math.round((size - 17) / 4);
}

// ────────────────────────────────────────────────────────────────
// CLI 引数
// ────────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    dataset:  './opqr_benchmark_dataset',
    output:   './opqr_comparison',
    text:     'OPQR code',
    versions: ['v07', 'v10', 'v20'],
    cell:     8,
    margin:   4,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--dataset':  opts.dataset  = args[++i]; break;
      case '--output':   opts.output   = args[++i]; break;
      case '--text':     opts.text     = args[++i]; break;
      case '--versions': opts.versions = args[++i].split(','); break;
      case '--cell':     opts.cell     = parseInt(args[++i]); break;
      case '--margin':   opts.margin   = parseInt(args[++i]); break;
    }
  }
  return opts;
}

// ────────────────────────────────────────────────────────────────
// 画像ユーティリティ
// ────────────────────────────────────────────────────────────────
function loadGrayPng(filePath) {
  const buf = fs.readFileSync(filePath);
  const png = PNG.sync.read(buf);
  const { width, height, data } = png;
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    gray[i] = Math.round(0.299 * data[i*4] + 0.587 * data[i*4+1] + 0.114 * data[i*4+2]);
  }
  return { gray, width, height };
}

function otsuThreshold(gray) {
  const hist = new Float64Array(256);
  for (const v of gray) hist[v]++;
  const total = gray.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let sumBg = 0, wBg = 0, maxVar = 0, threshold = 128;
  for (let t = 0; t < 256; t++) {
    wBg += hist[t];
    if (wBg === 0) continue;
    const wFg = total - wBg;
    if (wFg === 0) break;
    sumBg += t * hist[t];
    const muBg = sumBg / wBg;
    const muFg = (sumAll - sumBg) / wFg;
    const v = wBg * wFg * (muBg - muFg) ** 2;
    if (v > maxVar) { maxVar = v; threshold = t; }
  }
  return threshold;
}

/** Floyd-Steinberg 誤差拡散二値化 → 0(白)/1(黒) Uint8Array */
function floydSteinbergDither(gray, width, height) {
  const threshold = otsuThreshold(gray);
  const buf = new Float32Array(gray);
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const old = buf[idx];
      const nw  = old < threshold ? 0 : 255;
      out[idx]  = nw === 0 ? 1 : 0;
      const err = old - nw;
      if (x + 1 < width)             buf[idx + 1]         += err * 7 / 16;
      if (y + 1 < height) {
        if (x - 1 >= 0)              buf[idx + width - 1] += err * 3 / 16;
                                     buf[idx + width]      += err * 5 / 16;
        if (x + 1 < width)           buf[idx + width + 1] += err * 1 / 16;
      }
    }
  }
  return out;
}

/** 最近傍補間でリサイズ（ピクセルアート向け） */
function resizeNearest(src, sw, sh, dw, dh) {
  const dst = new Uint8Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const sy = Math.floor((y * sh) / dh);
      const sx = Math.floor((x * sw) / dw);
      dst[y * dw + x] = src[sy * sw + sx];
    }
  }
  return dst;
}

// ────────────────────────────────────────────────────────────────
// QR 構造マスク
// qrcode.js が生成した QR のうち「上書き禁止」な構造要素を特定する。
// ファインダーパターン・区切り・タイミング・アライメント・フォーマット情報・
// バージョン情報が対象。
// ────────────────────────────────────────────────────────────────
function buildStructuralMask(size) {
  const mask = new Uint8Array(size * size);
  const mark = (r0, c0, r1, c1) => {
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++)
        if (r >= 0 && r < size && c >= 0 && c < size) mask[r * size + c] = 1;
  };
  // ファインダーパターン + 区切り (各 8×8)
  mark(0, 0,        8, 8);
  mark(0, size - 8, 8, size - 1);
  mark(size - 8, 0, size - 1, 8);
  // タイミングパターン (行6 / 列6)
  for (let i = 0; i < size; i++) { mask[6 * size + i] = 1; mask[i * size + 6] = 1; }
  // アライメントパターン
  const version = Math.round((size - 17) / 4);
  const centers = getAlignmentCenters(version);
  for (const r of centers)
    for (const c of centers) {
      if ((r < 10 && c < 10) || (r < 10 && c > size-10) || (r > size-10 && c < 10)) continue;
      mark(r - 2, c - 2, r + 2, c + 2);
    }
  // フォーマット情報
  for (let i = 0; i <= 8; i++) {
    mask[8 * size + i] = 1; mask[i * size + 8] = 1;
    mask[8 * size + (size - 1 - i)] = 1;
    mask[(size - 1 - i) * size + 8] = 1;
  }
  // バージョン情報 (v7+)
  if (version >= 7) {
    mark(0, size - 11, 5, size - 9);
    mark(size - 11, 0, size - 9, 5);
  }
  return mask;
}

function getAlignmentCenters(v) {
  const t=[
    [],[],[6,18],[6,22],[6,26],[6,30],[6,34],
    [6,22,38],[6,24,42],[6,26,46],[6,28,50],[6,30,54],
    [6,32,58],[6,34,62],[6,26,46,66],[6,26,48,70],
    [6,26,50,74],[6,30,54,78],[6,30,56,82],[6,30,58,86],
    [6,34,62,90],[6,28,50,72,94],[6,26,50,74,98],
    [6,30,54,78,102],[6,28,54,80,106],[6,32,58,84,110],
    [6,30,58,86,114],[6,34,62,90,118],[6,26,50,74,98,122],
    [6,30,54,78,102,126],[6,26,52,78,104,130],
    [6,30,56,82,108,134],[6,34,60,86,112,138],
    [6,30,58,86,114,142],[6,34,62,90,118,146],
    [6,30,54,78,102,126,150],[6,24,50,76,102,128,154],
    [6,28,54,80,106,132,158],[6,32,58,84,110,136,162],
    [6,26,54,82,110,138,166],[6,30,58,86,114,142,170],
  ];
  return (v >= 1 && v <= 40) ? (t[v] ?? []) : [];
}

// ────────────────────────────────────────────────────────────────
// テキスト → UTF-8 バイト列文字列
// ────────────────────────────────────────────────────────────────
function toUtf8ByteString(text) {
  return Array.from(Buffer.from(text, 'utf8'), (b) => String.fromCharCode(b)).join('');
}

// ────────────────────────────────────────────────────────────────
// QR 生成ヘルパー
// ────────────────────────────────────────────────────────────────
function makeQR(text, typeNumber, ecl) {
  const qr = qrcodeFactory(typeNumber, ecl);
  qr.addData(toUtf8ByteString(text), 'Byte');
  qr.make();
  return qr;
}

// ────────────────────────────────────────────────────────────────
// PNG レンダリング
// moduleGrid: 2D関数 (row, col) → boolean (true=暗)
// ────────────────────────────────────────────────────────────────
function renderToPNG(isDark, moduleCount, cellSize, margin) {
  const total = (moduleCount + margin * 2) * cellSize;
  const png   = new PNG({ width: total, height: total, colorType: 2 });
  png.data.fill(255);
  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      const px   = isDark(row, col) ? 0 : 255;
      const bx   = (margin + col) * cellSize;
      const by   = (margin + row) * cellSize;
      for (let dy = 0; dy < cellSize; dy++)
        for (let dx = 0; dx < cellSize; dx++) {
          const i = ((by + dy) * total + (bx + dx)) * 4;
          png.data[i] = png.data[i+1] = png.data[i+2] = px;
          png.data[i+3] = 255;
        }
    }
  }
  return PNG.sync.write(png);
}

// ────────────────────────────────────────────────────────────────
// 手法 1: standard
// 標準 QR コード（画像なし）。全手法の読み取り性比較ベースライン。
// ────────────────────────────────────────────────────────────────
function generateStandard(text, typeNumber, ecl, cellSize, margin) {
  const qr   = makeQR(text, typeNumber, ecl);
  const size = qr.getModuleCount();
  const buf  = renderToPNG((r, c) => qr.isDark(r, c), size, cellSize, margin);
  return { buf, meta: { method: 'standard', ecl, overrideCount: 0, overrideRatio: 0 } };
}

// ────────────────────────────────────────────────────────────────
// 手法 2: center_logo
// ロゴ（画像）をQRコード中央に配置し、ECC で補完する手法。
// （Apple/WeChat QR など市場で最も普及している手法）
//
// logoRatio: ロゴが QR 一辺に占める割合 (0.0–1.0)
//   0.15 → 一辺の 15%、面積比 2.25%  (ECL=L で概ね安全)
//   0.30 → 一辺の 30%、面積比 9%     (ECL=M 以上を推奨)
//
// 論文での記述例:
//   "Center logo covering 9% of the QR area (ECL=M)"
// ────────────────────────────────────────────────────────────────
function generateCenterLogo(text, typeNumber, ecl, imgGray, imgSize, logoRatio, cellSize, margin) {
  const qr       = makeQR(text, typeNumber, ecl);
  const qrSize   = qr.getModuleCount();
  const logoSize = Math.max(3, Math.round(qrSize * logoRatio));
  const offset   = Math.floor((qrSize - logoSize) / 2);

  // ロゴ画像をロゴサイズにリサイズ → Floyd-Steinberg 二値化
  const resized = resizeNearest(imgGray, imgSize, imgSize, logoSize, logoSize);
  const logoBin = floydSteinbergDither(resized, logoSize, logoSize);

  let overrideCount = 0;
  const isDark = (r, c) => {
    const lr = r - offset;
    const lc = c - offset;
    if (lr >= 0 && lr < logoSize && lc >= 0 && lc < logoSize) {
      overrideCount++;
      return logoBin[lr * logoSize + lc] === 1;
    }
    return qr.isDark(r, c);
  };

  const buf = renderToPNG(isDark, qrSize, cellSize, margin);
  const totalFree = qrSize * qrSize;
  return {
    buf,
    meta: {
      method:         'center_logo',
      ecl,
      logoRatio,
      logoSize:       `${logoSize}×${logoSize}`,
      overrideCount,
      overrideRatio:  (overrideCount / totalFree).toFixed(4),
      withinCapacity: overrideCount / totalFree <= ECC_CAPACITY[ecl],
    },
  };
}

// ────────────────────────────────────────────────────────────────
// 手法 3: ecc_overlay
// QR コードの非構造モジュールを画像ピクセルで上書きする手法。
// Halftone QR Code (Chu et al., SIGGRAPH Asia 2013) の基本概念に相当。
//
// Chu et al. との主な違い:
//   - Chu et al.: 誤差拡散ハーフトーンで暗/明モジュール選択し、
//                 ECC 消費量を最小化する最適化を行う
//   - 本実装 (simplified): 左上→右下の走査順で非構造モジュールを上書き、
//                          ECC 容量に達した時点で打ち切る
//
// limitToCapacity: true → ECC 容量内に制限 (現実的な読み取り可能バージョン)
//                  false → 全非構造モジュールを上書き (視覚品質優先・読み取り不可の可能性)
//
// 両方出力して「視覚品質 vs. 読み取り性のトレードオフ」を論文で示す。
// ────────────────────────────────────────────────────────────────
function generateEccOverlay(text, typeNumber, ecl, imgGray, imgSize, limitToCapacity, cellSize, margin) {
  const qr      = makeQR(text, typeNumber, ecl);
  const qrSize  = qr.getModuleCount();
  const strMask = buildStructuralMask(qrSize);

  // 画像を QR サイズにリサイズ → Floyd-Steinberg 二値化
  const resized = resizeNearest(imgGray, imgSize, imgSize, qrSize, qrSize);
  const imgBin  = floydSteinbergDither(resized, qrSize, qrSize);

  const totalModules = qrSize * qrSize;
  const maxOverride  = limitToCapacity
    ? Math.floor(totalModules * ECC_CAPACITY[ecl])
    : Infinity;

  // 上書きマップを事前構築（走査順に容量上限まで）
  const overrideMap = new Uint8Array(totalModules).fill(255); // 255 = use QR
  let overrideCount = 0;
  let mismatchCount = 0;

  for (let r = 0; r < qrSize; r++) {
    for (let c = 0; c < qrSize; c++) {
      const idx    = r * qrSize + c;
      const isStr  = strMask[idx] === 1;
      const imgPx  = imgBin[idx];
      const qrDark = qr.isDark(r, c) ? 1 : 0;

      if (isStr) continue; // 構造要素は変更しない

      if (imgPx !== qrDark) mismatchCount++;

      if (overrideCount < maxOverride) {
        overrideMap[idx] = imgPx; // 0=白, 1=黒 で上書き
        if (imgPx !== qrDark) overrideCount++;
      }
      // 容量制限ありの場合、制限を超えた分は QR の値を維持
    }
  }

  const isDark = (r, c) => {
    const idx = r * qrSize + c;
    if (overrideMap[idx] !== 255) return overrideMap[idx] === 1;
    return qr.isDark(r, c);
  };

  const buf = renderToPNG(isDark, qrSize, cellSize, margin);
  return {
    buf,
    meta: {
      method:            'ecc_overlay',
      ecl,
      limitToCapacity,
      totalModules,
      mismatchCount,      // 画像と QR が食い違うモジュール数
      mismatchRatio:      (mismatchCount / totalModules).toFixed(4),
      overrideCount,      // 実際に上書きしたモジュール数
      overrideRatio:      (overrideCount / totalModules).toFixed(4),
      eccCapacityRatio:   ECC_CAPACITY[ecl].toFixed(2),
      withinCapacity:     overrideCount / totalModules <= ECC_CAPACITY[ecl],
    },
  };
}

// ────────────────────────────────────────────────────────────────
// メイン
// ────────────────────────────────────────────────────────────────
function main() {
  const opts       = parseArgs();
  const datasetDir = path.resolve(opts.dataset);
  const outputDir  = path.resolve(opts.output);

  const manifestPath = path.join(datasetDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(`[ERROR] manifest.json が見つかりません: ${manifestPath}`);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  fs.mkdirSync(outputDir, { recursive: true });

  // ── 生成する手法の一覧 ──
  // (id, 説明, 生成関数を返すファクトリ)
  // 関数シグネチャ: (text, typeNumber, ecl, imgGray, imgSize) → { buf, meta }
  const METHODS = [
    {
      id: 'standard_L',
      label: '標準QR (ECL=L, 画像なし)',
      ecl: 'L',
      gen: (text, tn, imgGray, imgSize) =>
        generateStandard(text, tn, 'L', opts.cell, opts.margin),
    },
    {
      id: 'center_logo_15pct_L',
      label: 'センターロゴ 15% / ECL=L',
      ecl: 'L',
      gen: (text, tn, imgGray, imgSize) =>
        generateCenterLogo(text, tn, 'L', imgGray, imgSize, 0.15, opts.cell, opts.margin),
    },
    {
      id: 'center_logo_30pct_H',
      label: 'センターロゴ 30% / ECL=H',
      ecl: 'H',
      gen: (text, tn, imgGray, imgSize) =>
        generateCenterLogo(text, tn, 'H', imgGray, imgSize, 0.30, opts.cell, opts.margin),
    },
    {
      id: 'ecc_overlay_limited_L',
      label: 'ECC オーバーレイ (ECL=L, 容量内制限)',
      ecl: 'L',
      gen: (text, tn, imgGray, imgSize) =>
        generateEccOverlay(text, tn, 'L', imgGray, imgSize, true, opts.cell, opts.margin),
    },
    {
      id: 'ecc_overlay_limited_H',
      label: 'ECC オーバーレイ (ECL=H, 容量内制限)',
      ecl: 'H',
      gen: (text, tn, imgGray, imgSize) =>
        generateEccOverlay(text, tn, 'H', imgGray, imgSize, true, opts.cell, opts.margin),
    },
    {
      id: 'ecc_overlay_full_H',
      label: 'ECC オーバーレイ (ECL=H, 全非構造モジュール上書き・読取不可の可能性)',
      ecl: 'H',
      gen: (text, tn, imgGray, imgSize) =>
        generateEccOverlay(text, tn, 'H', imgGray, imgSize, false, opts.cell, opts.margin),
    },
  ];

  const log = {
    generated_at: new Date().toISOString(),
    text: opts.text,
    methods: METHODS.map(m => ({ id: m.id, label: m.label, ecl: m.ecl })),
    results: [],
  };

  const totalJobs = manifest.images.length * opts.versions.length * METHODS.length;
  let jobsDone = 0;

  for (const imgEntry of manifest.images) {
    const imgId    = imgEntry.id;
    const imgDir   = path.join(outputDir, imgId);
    fs.mkdirSync(imgDir, { recursive: true });
    const imgResult = { id: imgId, versions: {} };

    for (const versionId of opts.versions) {
      const grayRelPath = imgEntry.versions?.[versionId]?.gray;
      if (!grayRelPath) { console.warn(`  [SKIP] ${imgId}/${versionId}: データなし`); continue; }
      const grayPath = path.join(datasetDir, grayRelPath);
      if (!fs.existsSync(grayPath)) { console.warn(`  [SKIP] ${grayPath}: ファイルなし`); continue; }

      const { gray: imgGray, width: imgSize } = loadGrayPng(grayPath);
      const typeNumber = typeNumberFromVersionId(versionId);

      imgResult.versions[versionId] = { method_results: [] };

      for (const method of METHODS) {
        process.stdout.write(
          `  [${++jobsDone}/${totalJobs}] ${imgId} / ${versionId} / ${method.id} ... `
        );
        try {
          const { buf, meta } = method.gen(opts.text, typeNumber, imgGray, imgSize);
          const filename = `${imgId}_${versionId}_${method.id}.png`;
          const outPath  = path.join(imgDir, filename);
          fs.writeFileSync(outPath, buf);
          imgResult.versions[versionId].method_results.push({
            method_id: method.id,
            file: path.relative(outputDir, outPath),
            ...meta,
          });
          const capacity = meta.withinCapacity !== undefined
            ? (meta.withinCapacity ? ' [capacity OK]' : ' [EXCEEDS capacity]')
            : '';
          console.log(`OK${capacity}`);
        } catch (err) {
          console.log(`FAIL: ${err.message}`);
        }
      }
    }
    log.results.push(imgResult);
  }

  const logPath = path.join(outputDir, 'comparison_manifest.json');
  fs.writeFileSync(logPath, JSON.stringify(log, null, 2));

  console.log('');
  console.log(`完了: ${jobsDone} ファイル生成`);
  console.log(`マニフェスト: ${logPath}`);
  console.log('');
  printCapacitySummary(log);
}

// ────────────────────────────────────────────────────────────────
// ECC 容量サマリを表示（論文の Table 作成補助）
// ────────────────────────────────────────────────────────────────
function printCapacitySummary(log) {
  console.log('── ECC 容量サマリ ─────────────────────────────────────────');
  console.log('手法                      ECL  容量上限  平均上書率  容量内%');
  console.log('──────────────────────────────────────────────────────────');

  // method_id ごとに集計
  const stats = {};
  for (const imgResult of log.results) {
    for (const [, vdata] of Object.entries(imgResult.versions)) {
      for (const r of vdata.method_results) {
        if (!stats[r.method_id]) stats[r.method_id] = { total: 0, withinCap: 0, ratioSum: 0, ecl: r.ecl };
        stats[r.method_id].total++;
        if (r.withinCapacity) stats[r.method_id].withinCap++;
        stats[r.method_id].ratioSum += parseFloat(r.overrideRatio ?? 0);
      }
    }
  }

  for (const [id, s] of Object.entries(stats)) {
    const cap    = ECC_CAPACITY[s.ecl] ?? '?';
    const avgR   = (s.ratioSum / s.total).toFixed(3);
    const pctOK  = ((s.withinCap / s.total) * 100).toFixed(0);
    const label  = id.padEnd(26);
    console.log(`${label} ${s.ecl}   ${(cap*100).toFixed(0).padStart(4)}%    ${avgR}   ${pctOK}%`);
  }
  console.log('──────────────────────────────────────────────────────────');
}

main();
