# OPQR Code — Reference Implementation and Benchmark

**OPQR (Off-standard Padding QR) Code** embeds pixel-art images into QR codes
by replacing padding codewords — fill bytes appended when the encoded message is
shorter than the data capacity — with a binarized representation of the target image.

Unlike visual QR methods that overwrite error-correction (ECC) codewords, OPQR Code
leaves the ECC capacity entirely intact. The ECC is recomputed over the modified
codeword stream, so the resulting code achieves **zero decoding error** with any
standard QR reader.

This repository contains:

- **`src/`** — Reference implementation of the core algorithm (extracted from [OPQRcoder](https://apps.apple.com/app/opqrcoder/id6464173069), an iOS app)
- **`benchmark/`** — Ten-image pixel-art dataset, generated QR codes, and evaluation scripts

> **Paper**: "OPQR Code: Zero-Error Image Embedding in QR Codes via Off-Standard
> Padding Codeword Replacement", Kaname Endo and Takaho Endo.
> Submitted to IEEE Transactions on Consumer Electronics (2025).

---

## How It Works

A QR code of version *v* at ECC level *L* has a fixed data capacity
*C*_data(*v*, *L*) codewords. When the user message occupies only *B* + *B*_overhead
bytes, the remaining *N*_pad = *C*_data − *B* − *B*_overhead bytes are padded with a
fixed alternating sequence of `0xEC` and `0x11` (ISO/IEC 18004).

OPQR Code replaces these padding bytes with image-derived values:

```
1. Encode user text → QR code (standard encoder, mask pattern p*)
2. Binarize image with serpentine Floyd-Steinberg + Otsu threshold + jitter
3. Write binary image pixels into padding codeword positions via bitmapper
4. (Optional) Apply penalty-weighted noise insertion to resolve black-ratio imbalance
5. Recompute ECC over the modified codeword stream with the same mask p*
→ Fully valid, decodable QR code with embedded image
```

For `"OPQR code"` (9 bytes) at QR v7 / ECL=L:
*N*_pad = 185 codewords = **1,480 modules** = **82.6%** of the data region.

---

## Source Files (`src/`)

All files are extracted from the OPQRcoder iOS app and are self-contained with
no dependency on React Native or Expo APIs.

| File | Description |
|------|-------------|
| `core/qrcode.js` | Standard QR encoder extended with `get_bitmapper()`, `plot_pixel(r,c,v)`, `flip_pixel(r,c)` |
| `core/qrcode.d.ts` | TypeScript declarations for the extended encoder |
| `services/ImageService.ts` | Otsu threshold, serpentine-scan Floyd-Steinberg dithering with threshold jitter |
| `services/OPQRCodeService.ts` | End-to-end pipeline: `generateOPQR()`, `prepareQRSession()`, `minVersionForText()` |
| `services/NoiseService.ts` | Penalty-weighted noise insertion, pattern risk score (`calculatePatternRiskScore`) |
| `services/ColorService.ts` | Flood-fill colorization (per-connected-region uniform color for decode reliability) |

### Key APIs

```ts
import qrcodeFactory from './core/qrcode.js';
import { generateOPQR } from './services/OPQRCodeService';
import { floydSteinbergDither } from './services/ImageService';

// Generate an OPQR Code
const result = generateOPQR({
  text: 'OPQR code',
  version: 7,
  errorLevel: 'L',
  imagePixels: grayPixels,   // Uint8Array of grayscale values
  imageSize: 45,             // must match QR module count for v7
  noiseLevel: 0.05,          // 5% penalty-weighted noise insertion
});

// result.isDark(row, col)   → boolean module value
// result.moduleCount        → 45 for v7
// result.maskPattern        → applied mask (0–7)
```

### Extended QR Encoder APIs

```js
const qr = qrcodeFactory(version, errorLevel);
qr.addData(text, 'Byte');
qr.make(maskPattern);          // standard make

const bitmapper = qr.get_bitmapper();
// bitmapper.plot_pixel(row, col, value)  → overwrite a padding module (0 or 1)
// bitmapper.flip_pixel(row, col)         → toggle a padding module

qr.__clearCache();
qr.make(maskPattern);          // recompute ECC after modification
```

### Notes on the TypeScript files

The `.ts` files use module-relative imports as written in the app:

```ts
import qrcodeFactory from '../core/qrcode.js';
import type { OPQRCode } from '../core/qrcode';
```

For use outside a bundler, adjust import paths or compile with `tsc`. The files
have no external dependencies beyond the standard `TextEncoder` Web API.

---

## Benchmark (`benchmark/`)

### Dataset

Ten pixel-art images generated with Stable Diffusion XL (Draw Things, local API,
seed 20250416) at 512×512 pixels, covering a range of visual characteristics:

| ID | Name | Characteristic |
|----|------|----------------|
| 01 | heart | Simple geometry, ~30% dark |
| 02 | arrow | Simple geometry, directional |
| 03 | face | Portrait, mid-tone |
| 04 | building | Architecture, structured edges |
| 05 | mountain | Natural gradient, ~69% dark (ZBar failure case at ρ=0%) |
| 06 | sky_dither | Sky gradient, ~60% dark (ZBar failure case at ρ=0%) |
| 07 | dense_sprite | High spatial frequency |
| 08 | sparse | Sparse pattern, ~20% dark |
| 09 | pixel_char | Pixel character, fine detail |
| 10 | pattern | Regular tileable pattern |

`dataset/full/` — 512×512 source images  
`dataset/v07/` — Scaled to 45×45 (v7 module resolution), color and grayscale variants

### Generated QR Codes

`results/opqr/` — OPQR Code outputs (v7/v10/v20 × noise 0–30% in 5% steps)  
`results/dither/` — Serpentine+jitter dither variant (v7, noise 0–20%)  
`results/comparison/` — Comparison method outputs (v7):
  - `standard_L` — Plain QR, ECL=L (decode ceiling, 100%)
  - `center_logo_15pct_L` — Center logo 15% side, ECL=L
  - `center_logo_30pct_H` — Center logo 30% side, ECL=H
  - `ecc_overlay_limited_L` — **Intentionally undecodable** negative control (see below)
  - `ecc_overlay_limited_H` — **Intentionally undecodable** negative control (see below)
  - `ecc_overlay_full_H` — **Intentionally undecodable** negative control (see below)

#### Why the ECC overlay methods are intentionally undecodable

These three methods naively overwrite non-structural QR modules with image-derived
pixel values — the same idea used by many visual QR code approaches that rely on
the ECC budget. They are included as **negative controls**, not as functional QR codes.

Reed-Solomon error correction is designed to handle **burst errors**: localized
damage such as dirt, scratches, or print dropouts. The ECC budget (7% for ECL=L,
30% for ECL=H) is specified under this assumption.

When image pixels are distributed uniformly across the entire module grid, the
resulting error pattern is **non-bursty**: errors are spread across every codeword
rather than concentrated in a few. Reed-Solomon encounters more error symbols than
its designed burst capacity and fails completely — even when the override count is
numerically within the nominal budget.

This explains why `ecc_overlay_limited_L` (7%, within ECL=L budget) scores **0%**,
not some partial success. The center-logo methods score non-zero because a central
logo creates a localized error cluster that is closer to the burst-error assumption.

The key finding: **the ECC percentage budget is not a safe override quota for
arbitrary image data.** OPQR Code avoids this entirely by using padding codewords,
which are outside the ECC codeword region and can be freely replaced without
affecting error-correction capacity at all.

> **Note**: QR images in `results/` were generated with the encoded text
> `https://opqrcode.app`. The benchmark should be regenerated with text
> `OPQR code` before final publication. Run `generate_opqr_batch.js` and
> `generate_comparison.js` to regenerate.

### Evaluation

Requires Python 3.9+, ZBar (via pyzbar), and ZXing (via zxing-cpp):

```bash
# macOS (Apple Silicon)
brew install zbar
pip install pyzbar zxing-cpp pillow

# Evaluate OPQR results
DYLD_LIBRARY_PATH=/opt/homebrew/lib python3 evaluate_qr.py \
  --opqr results/opqr \
  --compare results/comparison \
  --output eval_results.json

# x86 / Linux: DYLD_LIBRARY_PATH not needed
python3 evaluate_qr.py --opqr results/opqr --compare results/comparison
```

`eval_results.json` contains the evaluation results for all conditions:

```
opqr:    210 records  (10 images × 3 versions × 7 noise levels)
dither:   40 records  (10 images × 1 version  × 4 noise levels)
compare:  60 records  (10 images × 6 methods)
```

### Key Results (Phase 1 — Digital Evaluation)

| Method | ZBar | ZXing |
|--------|------|-------|
| Standard-L | 100% | 100% |
| CenterLogo-15%-L | 70% | 100% |
| CenterLogo-30%-H | 50% | 100% |
| ECCOverlay-L (7%) | **0%** | **0%** |
| ECCOverlay-H (30%) | **0%** | **0%** |
| ECCOverlay-Full-H | **0%** | **0%** |
| **OPQR ρ=0%** | 80% | **100%** |
| **OPQR ρ≥5%** | **100%** | **100%** |

ECC-overlay methods fail at 0% because image-derived bit patterns distributed
across the full code exceed Reed-Solomon burst-error capacity even when the
override count is nominally within the ECC budget.

---

## Application

OPQRcoder is available on the Apple App Store for iPhone and iPad:  
[https://apps.apple.com/app/opqrcoder/id6464173069](https://apps.apple.com/app/opqrcoder/id6464173069)

---

## Citation

```bibtex
@article{endo2025opqr,
  author  = {Endo, Kaname and Endo, Takaho},
  title   = {{OPQR} Code: Zero-Error Image Embedding in {QR} Codes
             via Off-Standard Padding Codeword Replacement},
  journal = {IEEE Transactions on Consumer Electronics},
  year    = {2025},
  note    = {Submitted},
}
```

---

## License

Source code: MIT License (see [LICENSE](LICENSE)).  
Benchmark images: generated with Stable Diffusion XL for research use.
