#!/usr/bin/env node
'use strict';
/**
 * OPQR Batch Generator CLI
 *
 * ベンチマーク画像セットに対して dither (noiseLevel) パラメータを変化させながら
 * OPQR コードを一括生成する。
 *
 * 使い方:
 *   node generate_opqr_batch.js [options]
 *
 * オプション:
 *   --dataset  <dir>   ベンチマークデータセットのディレクトリ (default: ./opqr_benchmark_dataset)
 *   --output   <dir>   出力先ディレクトリ (default: ./opqr_results)
 *   --text     <str>   QRコードに埋め込むテキスト (default: "OPQR code")
 *   --ecl      <L|M|Q|H>  誤り訂正レベル (default: L)
 *   --noise    <list>  ノイズレベル一覧 カンマ区切り 0-100 (default: 0,5,10,15,20,25,30)
 *   --versions <list>  対象QRバージョン識別子 カンマ区切り (default: v07,v10,v20)
 *   --cell     <px>    出力画像のセルサイズ px (default: 8)
 *   --margin   <cells> 余白セル数 (default: 4)
 *
 * 例:
 *   node generate_opqr_batch.js --text "https://example.com" --noise 0,10,20,30
 */

const fs   = require('fs');
const path = require('path');

// ── 親プロジェクトの依存を直接参照（インストール不要） ──────────────
const PROJ_ROOT = path.resolve(__dirname, '../OPQRcode-rn');
const { PNG }   = require(path.join(PROJ_ROOT, 'node_modules/pngjs'));
const qrcodeFactory = require(path.join(PROJ_ROOT, 'src/core/qrcode.js'));

// ────────────────────────────────────────────────────────────────
// CLI 引数パース
// ────────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    dataset:  './opqr_benchmark_dataset',
    output:   './opqr_results',
    text:     'OPQR code',
    ecl:      'L',
    noise:    [0, 5, 10, 15, 20, 25, 30],
    versions: ['v07', 'v10', 'v20'],
    cell:     8,
    margin:   4,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--dataset':  opts.dataset  = args[++i]; break;
      case '--output':   opts.output   = args[++i]; break;
      case '--text':     opts.text     = args[++i]; break;
      case '--ecl':      opts.ecl      = args[++i]; break;
      case '--noise':    opts.noise    = args[++i].split(',').map(Number); break;
      case '--versions': opts.versions = args[++i].split(','); break;
      case '--cell':     opts.cell     = parseInt(args[++i]); break;
      case '--margin':   opts.margin   = parseInt(args[++i]); break;
      default: console.warn(`Unknown option: ${args[i]}`);
    }
  }
  return opts;
}

// ────────────────────────────────────────────────────────────────
// QR バージョン識別子 → モジュール数
// ────────────────────────────────────────────────────────────────
const VERSION_MAP = { v07: 45, v10: 57, v20: 97 };
function moduleCountFromVersionId(vid) {
  if (VERSION_MAP[vid]) return VERSION_MAP[vid];
  // "v07" 以外の形式にも対応: モジュール数を直接数値で指定した場合
  const n = parseInt(vid);
  if (!isNaN(n)) return n;
  throw new Error(`Unknown QR version identifier: ${vid}`);
}

// ────────────────────────────────────────────────────────────────
// テキスト → UTF-8 バイト列文字列変換
// OPQRCodeService.ts の toUtf8ByteString() と同等
// ────────────────────────────────────────────────────────────────
function toUtf8ByteString(text) {
  const bytes = Buffer.from(text, 'utf8');
  return Array.from(bytes, (b) => String.fromCharCode(b)).join('');
}

// ────────────────────────────────────────────────────────────────
// PNG 読み込み → グレースケール Uint8Array
// ────────────────────────────────────────────────────────────────
function loadGrayPng(filePath) {
  const buf = fs.readFileSync(filePath);
  const png = PNG.sync.read(buf);
  const { width, height, data } = png; // data は RGBA
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    // RGBA → 輝度 (BT.601)
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return { gray, width, height };
}

// ────────────────────────────────────────────────────────────────
// Floyd-Steinberg 誤差拡散二値化
//
// 単純な128閾値では大きいフラット領域が生まれ、QRデコーダが
// ファインダーパターンや暗モジュール列を誤検出しやすくなる。
// 誤差拡散により黒白が均等に分布し、低ノイズ時も読み取り性が向上する。
//
// 閾値は Otsu 法で自動決定する（画像ごとに最適な分離点を使う）。
//
// 入力: gray  - 輝度値 Uint8Array (0-255)
//       width, height
// 出力: binary Uint8Array — 0 (白モジュール) / 1 (黒モジュール)
// ────────────────────────────────────────────────────────────────
function otsuThreshold(gray) {
  // 256段階ヒストグラム
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
    const varBetween = wBg * wFg * (muBg - muFg) ** 2;
    if (varBetween > maxVar) { maxVar = varBetween; threshold = t; }
  }
  return threshold;
}

function floydSteinbergDither(gray, width, height) {
  const threshold = otsuThreshold(gray);

  // Float32 バッファで誤差蓄積（Uint8 では精度不足）
  const buf = new Float32Array(gray);
  const out = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const old = buf[idx];
      // Otsu 閾値で二値化
      const nw  = old < threshold ? 0 : 255;
      out[idx]  = nw === 0 ? 1 : 0;       // QR 用: 黒=1, 白=0
      const err = old - nw;

      // 誤差拡散 (Floyd-Steinberg カーネル)
      if (x + 1 < width)               buf[idx + 1]           += err * 7 / 16;
      if (y + 1 < height) {
        if (x - 1 >= 0)                buf[idx + width - 1]   += err * 3 / 16;
                                       buf[idx + width]        += err * 5 / 16;
        if (x + 1 < width)             buf[idx + width + 1]   += err * 1 / 16;
      }
    }
  }
  return out; // 0 or 1
}

// ────────────────────────────────────────────────────────────────
// OPQR 生成: 画像埋め込み + EC 再計算
// OPQRCodeService.ts の prepareQRSession() と同等
// ────────────────────────────────────────────────────────────────
function prepareQRSession({ text, ecl, version, imagePixels, imageSize }) {
  const encoded = toUtf8ByteString(text);
  const qr = qrcodeFactory(version, ecl);
  qr.addData(encoded, 'Byte');
  qr.make();

  const appliedMask = qr.__get_mask_pattern();
  const bitmapper   = qr.get_bitmapper();
  const qrSize      = qr.__get_size();

  // 画像埋め込み
  // imagePixels はグレースケール(0-255)。Floyd-Steinberg 誤差拡散で
  // 二値化してから埋め込む。単純閾値ではフラット領域が大きくなりすぎ、
  // 低ノイズ時に QR デコーダが構造パターンを誤検出するため。
  if (imagePixels && imageSize) {
    const binary = floydSteinbergDither(imagePixels, imageSize, imageSize);
    for (let row = 0; row < qrSize; row++) {
      for (let col = 0; col < qrSize; col++) {
        const imgRow  = Math.floor((row * imageSize) / qrSize);
        const imgCol  = Math.floor((col * imageSize) / qrSize);
        bitmapper.plot_pixel(row, col, binary[imgRow * imageSize + imgCol]);
      }
    }
  }

  return {
    bitmapper,
    size: qrSize,
    finalize() {
      qr.__clearCache();
      qr.make(appliedMask);
      return {
        moduleCount: qr.getModuleCount(),
        isDark:      (r, c) => qr.isDark(r, c),
        maskPattern: qr.__get_mask_pattern(),
      };
    },
  };
}

// ────────────────────────────────────────────────────────────────
// NoiseService.ts の移植
// ────────────────────────────────────────────────────────────────

/** QR 予約領域マスク（ファインダー・タイミング・アライメント・バージョン情報） */
function buildReservedMask(size) {
  const reserved = new Uint8Array(size * size);
  const markRect = (r0, c0, r1, c1) => {
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (r >= 0 && r < size && c >= 0 && c < size) reserved[r * size + c] = 1;
      }
    }
  };
  markRect(0, 0, 8, 8);
  markRect(0, size - 8, 8, size - 1);
  markRect(size - 8, 0, size - 1, 8);
  for (let i = 8; i < size - 8; i++) {
    reserved[6 * size + i] = 1;
    reserved[i * size + 6] = 1;
  }
  const version = Math.round((size - 17) / 4);
  const centers = getAlignmentPatternCenters(version);
  for (const r of centers) {
    for (const c of centers) {
      if ((r < 10 && c < 10) || (r < 10 && c > size - 10) || (r > size - 10 && c < 10)) continue;
      markRect(r - 2, c - 2, r + 2, c + 2);
    }
  }
  if (version >= 7) {
    markRect(0, size - 11, 5, size - 9);
    markRect(size - 11, 0, size - 9, 5);
  }
  return reserved;
}

function getAlignmentPatternCenters(version) {
  const table = [
    [], [], [6,18],[6,22],[6,26],[6,30],[6,34],
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
  return (version >= 1 && version <= 40) ? (table[version] ?? []) : [];
}

/** パディングセルのペナルティスコアを計算する */
function calculatePenalties(dark, isPadding, reserved, size) {
  const PENALTY_PATTERN = 40;
  const PENALTY_SERIAL  = 5;
  const PENALTY_SOLID   = 5;
  const PENALTY_BIAS    = 1;

  // 予約領域の隣接マップ
  const adjReserved = new Uint8Array(size * size);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!reserved[r * size + c]) continue;
      for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const nr = r + dr, nc = c + dc;
        if (nr >= 0 && nr < size && nc >= 0 && nc < size && !reserved[nr * size + nc])
          adjReserved[nr * size + nc] = 1;
      }
    }
  }

  const penalties = new Float32Array(size * size);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const idx = r * size + c;
      if (!isPadding[idx]) continue;

      let penalty = PENALTY_BIAS;
      if (adjReserved[idx]) penalty += PENALTY_PATTERN;

      const here = dark[idx];

      // 横方向の連続長
      let run = 1, cc = c - 1;
      while (cc >= 0 && dark[r * size + cc] === here) { run++; cc--; }
      cc = c + 1;
      while (cc < size && dark[r * size + cc] === here) { run++; cc++; }
      let maxRun = run;

      // 縦方向の連続長
      run = 1;
      let rr = r - 1;
      while (rr >= 0 && dark[rr * size + c] === here) { run++; rr--; }
      rr = r + 1;
      while (rr < size && dark[rr * size + c] === here) { run++; rr++; }
      maxRun = Math.max(maxRun, run);

      if (maxRun >= 5) penalty += PENALTY_SERIAL * (maxRun - 4);

      // 3×3 均質判定
      let solidCount = 0, totalNeighbors = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr, nc = c + dc;
          if (nr >= 0 && nr < size && nc >= 0 && nc < size) {
            totalNeighbors++;
            if (dark[nr * size + nc] === here) solidCount++;
          }
        }
      }
      if (totalNeighbors > 0 && solidCount === totalNeighbors) penalty += PENALTY_SOLID;

      penalties[idx] = penalty;
    }
  }
  return penalties;
}

/** Gumbel-max trick による重み付きランダムサンプリング */
function weightedSample(weights, indices, count) {
  if (indices.length === 0) return [];
  const n = Math.min(count, indices.length);
  const scored = indices.map((idx) => {
    const w = weights[idx];
    const u = Math.random();
    const gumbel = -Math.log(-Math.log(Math.max(u, 1e-10)));
    return { idx, score: Math.log(Math.max(w, 1e-10)) + gumbel };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, n).map((x) => x.idx);
}

/**
 * パディング領域にペナルティ重み付きノイズを挿入する (同期版)。
 * NoiseService.ts の applyAutoNoise() を Node.js 用に同期化したもの。
 */
function applyAutoNoiseSync(bitmapper, size, initialDark, isPadding, maxNoiseRatio) {
  const N_NOISE_PER_ITERATION = 25;
  const PENALTY_SERIAL        = 5;

  const reserved    = buildReservedMask(size);
  const maxNoise    = Math.floor(size * size * maxNoiseRatio);
  const dark        = new Uint8Array(initialDark);

  const paddingIndices = [];
  for (let i = 0; i < size * size; i++) {
    if (isPadding[i]) paddingIndices.push(i);
  }
  if (paddingIndices.length === 0 || maxNoise === 0) return;

  const noiseSet = new Set();

  while (noiseSet.size < maxNoise) {
    const penalties = calculatePenalties(dark, isPadding, reserved, size);

    let sumP = 0;
    for (const i of paddingIndices) sumP += penalties[i];
    const avgP = sumP / paddingIndices.length;
    if (avgP < PENALTY_SERIAL * 2) break;

    const candidates = paddingIndices.filter((i) => !noiseSet.has(i));
    if (candidates.length === 0) break;

    const toFlip = weightedSample(
      penalties,
      candidates,
      Math.min(N_NOISE_PER_ITERATION, candidates.length),
    );

    for (const idx of toFlip) {
      const row = Math.floor(idx / size);
      const col = idx % size;
      bitmapper.flip_pixel(row, col);
      dark[idx] = dark[idx] === 0 ? 1 : 0;
      noiseSet.add(idx);
    }
  }
}

/** bitmapper から dark 状態のスナップショットを取る */
function snapshotDarkState(bitmapper, size) {
  const dark = new Uint8Array(size * size);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const info = bitmapper.get_segment_map(r, c);
      dark[r * size + c] = info?.dark ? 1 : 0;
    }
  }
  return dark;
}

/** bitmapper からパディングマスクを取得する */
function buildPaddingMask(bitmapper, size) {
  const mask = new Uint8Array(size * size);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const info = bitmapper.get_segment_map(r, c);
      if (info?.padding) mask[r * size + c] = 1;
    }
  }
  return mask;
}

// ────────────────────────────────────────────────────────────────
// QR コードを PNG として書き出す
// ────────────────────────────────────────────────────────────────
function renderQRtoPNG(result, cellSize, margin) {
  const { moduleCount, isDark } = result;
  const totalCells = moduleCount + margin * 2;
  const imgSize    = totalCells * cellSize;
  const png        = new PNG({ width: imgSize, height: imgSize, colorType: 2 }); // RGB

  // 全白で初期化
  png.data.fill(255);

  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      const dark  = isDark(row, col);
      const px    = dark ? 0 : 255;
      const baseX = (margin + col) * cellSize;
      const baseY = (margin + row) * cellSize;
      for (let dy = 0; dy < cellSize; dy++) {
        for (let dx = 0; dx < cellSize; dx++) {
          const idx = ((baseY + dy) * imgSize + (baseX + dx)) * 4;
          png.data[idx]     = px;
          png.data[idx + 1] = px;
          png.data[idx + 2] = px;
          png.data[idx + 3] = 255;
        }
      }
    }
  }

  return PNG.sync.write(png);
}

// ────────────────────────────────────────────────────────────────
// パディング占有率（論文の評価指標）を計算する
// ────────────────────────────────────────────────────────────────
function calcPaddingStats(bitmapper, size) {
  let total   = 0;
  let padding = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const info = bitmapper.get_segment_map(r, c);
      if (!info) continue;
      if (!info.reserved) total++;
      if (info.padding)   padding++;
    }
  }
  return { total, padding, ratio: total > 0 ? padding / total : 0 };
}

// ────────────────────────────────────────────────────────────────
// バッチ処理メイン
// ────────────────────────────────────────────────────────────────
function main() {
  const opts = parseArgs();

  const datasetDir = path.resolve(opts.dataset);
  const outputDir  = path.resolve(opts.output);

  // manifest.json でデータセット情報を取得
  const manifestPath = path.join(datasetDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(`[ERROR] manifest.json が見つかりません: ${manifestPath}`);
    console.error('先に generate_benchmark.py を実行してデータセットを作成してください。');
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  // 出力ディレクトリ作成
  fs.mkdirSync(outputDir, { recursive: true });

  const ecl       = opts.ecl;
  const cellSize  = opts.cell;
  const margin    = opts.margin;

  const batchLog  = {
    generated_at: new Date().toISOString(),
    options: { ...opts, dataset: datasetDir, output: outputDir },
    results: [],
  };

  let totalCount = 0;
  const imageEntries = manifest.images;
  const totalJobs    = imageEntries.length * opts.versions.length * opts.noise.length;

  console.log(`対象画像数 : ${imageEntries.length}`);
  console.log(`QR バージョン: ${opts.versions.join(', ')}`);
  console.log(`ノイズレベル: ${opts.noise.join(', ')}`);
  console.log(`総ジョブ数  : ${totalJobs}`);
  console.log(`テキスト    : "${opts.text}"`);
  console.log(`誤り訂正    : ${ecl}`);
  console.log('');

  for (const imgEntry of imageEntries) {
    const imgId  = imgEntry.id;
    const imgDir = path.join(outputDir, imgId);
    fs.mkdirSync(imgDir, { recursive: true });

    const imgResult = { id: imgId, versions: {} };

    for (const versionId of opts.versions) {
      // グレースケール画像のパス
      const grayRelPath = imgEntry.versions?.[versionId]?.gray;
      if (!grayRelPath) {
        console.warn(`  [SKIP] ${imgId}/${versionId}: データセットに存在しません`);
        continue;
      }
      const grayPath = path.join(datasetDir, grayRelPath);
      if (!fs.existsSync(grayPath)) {
        console.warn(`  [SKIP] ${imgId}/${versionId}: ファイルが見つかりません: ${grayPath}`);
        continue;
      }

      const { gray: imagePixels, width: imageSize } = loadGrayPng(grayPath);

      // バージョンに対応する QR 型番を逆算
      // 注意: 型番はモジュール数から逆算するが、実際の型番は prepareQRSession で
      //       version=0 (auto) を使うと正しい型番が自動選択される。
      //       ここでは固定バージョンで生成したいため型番を指定する。
      const targetModules = moduleCountFromVersionId(versionId);
      const qrTypeNumber  = Math.round((targetModules - 17) / 4);

      // ── ノイズなし（baseline）で1回生成してパディング率を計算 ──
      const baseSession = prepareQRSession({
        text: opts.text,
        ecl,
        version: qrTypeNumber,
        imagePixels,
        imageSize,
      });
      const paddingStats = calcPaddingStats(baseSession.bitmapper, baseSession.size);

      imgResult.versions[versionId] = {
        qr_type_number: qrTypeNumber,
        module_count:   targetModules,
        padding_cells:  paddingStats.padding,
        total_free_cells: paddingStats.total,
        padding_ratio:  paddingStats.ratio.toFixed(4),
        noise_results:  [],
      };

      for (const noisePct of opts.noise) {
        const noiseRatio = noisePct / 100;
        const noiseTag   = String(noisePct).padStart(2, '0');
        const filename   = `${imgId}_${versionId}_noise${noiseTag}.png`;
        const outPath    = path.join(imgDir, filename);

        process.stdout.write(
          `  [${++totalCount}/${totalJobs}] ${imgId} / ${versionId} / noise=${noisePct}% ... `
        );

        try {
          // セッション再生成（ノイズ処理のために毎回新規作成する）
          const session = prepareQRSession({
            text: opts.text,
            ecl,
            version: qrTypeNumber,
            imagePixels,
            imageSize,
          });

          if (noiseRatio > 0) {
            const initialDark  = snapshotDarkState(session.bitmapper, session.size);
            const paddingMask  = buildPaddingMask(session.bitmapper, session.size);
            applyAutoNoiseSync(
              session.bitmapper,
              session.size,
              initialDark,
              paddingMask,
              noiseRatio,
            );
          }

          const result  = session.finalize();
          const pngData = renderQRtoPNG(result, cellSize, margin);
          fs.writeFileSync(outPath, pngData);

          const noiseEntry = {
            noise_pct: noisePct,
            noise_ratio: noiseRatio,
            file: path.relative(outputDir, outPath),
          };
          imgResult.versions[versionId].noise_results.push(noiseEntry);
          console.log('OK');
        } catch (err) {
          console.log(`FAIL: ${err.message}`);
        }
      }
    }
    batchLog.results.push(imgResult);
  }

  // バッチログを保存
  const logPath = path.join(outputDir, 'batch_manifest.json');
  fs.writeFileSync(logPath, JSON.stringify(batchLog, null, 2));

  console.log('');
  console.log(`完了: ${totalCount} ファイル生成`);
  console.log(`マニフェスト: ${logPath}`);
  console.log('');
  console.log('出力構造:');
  console.log(`  ${outputDir}/`);
  console.log('  ├── {image_id}/');
  console.log('  │   ├── {id}_v07_noise00.png   (ノイズなし・baseline)');
  console.log('  │   ├── {id}_v07_noise05.png');
  console.log('  │   └── ...');
  console.log('  └── batch_manifest.json         (パディング率・メタデータ)');
}

main();
