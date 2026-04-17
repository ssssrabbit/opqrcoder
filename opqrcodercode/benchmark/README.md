# Benchmark — OPQR Code Evaluation Dataset

## Directory Layout

```
benchmark/
├── dataset/
│   ├── full/          10 source images at 512×512 px (SDXL, seed 20250416)
│   └── v07/           Same images at 45×45 px (QR v7 module resolution),
│                      color (_color.png) and grayscale (_gray.png) variants
├── results/
│   ├── opqr/          OPQR Code outputs — v7/v10/v20 × noise 0–30%
│   ├── dither/        Serpentine+jitter dither variant — v7, noise 0–20%
│   └── comparison/    Comparison method outputs — v7, 6 methods
├── evaluate_qr.py     Decode-rate evaluation script (ZBar + ZXing)
├── generate_opqr_batch.js   Regenerate OPQR images
├── generate_comparison.js   Regenerate comparison images
├── eval_results.json  Evaluation output (see below)
└── experiment_plan.md Physical/camera evaluation protocol (Phase 2/3)
```

## Dataset Images

| File prefix | Description | Notes |
|-------------|-------------|-------|
| `01_heart` | Heart shape | ~30% dark modules |
| `02_arrow` | Arrow | Simple directional shape |
| `03_face` | Portrait face | Mid-tone |
| `04_building` | Architecture | Structured edges |
| `05_mountain` | Mountain landscape | ~69% dark — ZBar fails at ρ=0% |
| `06_sky_dither` | Sky gradient | ~60% dark — ZBar fails at ρ=0% |
| `07_dense_sprite` | Pixel sprite | High spatial frequency |
| `08_sparse` | Sparse pattern | ~20% dark |
| `09_pixel_char` | Pixel character | Fine detail |
| `10_pattern` | Tileable pattern | Regular grid |

## Comparison Methods and the ECC Overlay Negative Controls

`results/comparison/` contains six methods:

| Method | Override ratio | Decodable? | Purpose |
|--------|---------------|------------|---------|
| `standard_L` | 0% | Yes (100%) | Decode ceiling / baseline |
| `center_logo_15pct_L` | 2.4% | Partially (70% ZBar, 100% ZXing) | Logo QR reference |
| `center_logo_30pct_H` | 9.7% | Partially (50% ZBar, 100% ZXing) | Logo QR reference |
| `ecc_overlay_limited_L` | 7.0% | **No (0%)** | Negative control |
| `ecc_overlay_limited_H` | 30.0% | **No (0%)** | Negative control |
| `ecc_overlay_full_H` | 39.7% | **No (0%)** | Negative control |

### Why the overlay methods score 0% — and why that matters

The three `ecc_overlay_*` methods are **intentionally undecodable negative controls**.
They demonstrate what happens when image pixels are written directly over non-structural
QR modules without using OPQR Code's padding-codeword strategy.

**The burst-error assumption.**
Reed-Solomon ECC is designed for *burst errors*: localized damage (dirt, scratches,
print voids) concentrated in a few codewords. The ECC budget (7% at ECL=L,
30% at ECL=H) is specified under this assumption.

**Why image overlay violates the assumption.**
Overwriting modules with image-derived pixel values distributes errors *uniformly
across every codeword* in the code. Reed-Solomon encounters more independently
corrupted symbols than its burst capacity allows and fails completely — even for
`ecc_overlay_limited_L`, which overrides only 7% of modules, nominally within the
ECL=L budget.

**Why center logos partially work.**
A logo confined to the center creates a *localized cluster* of overridden modules,
which approximates the burst-error pattern RS was designed for. ZXing's more
aggressive error recovery allows it to succeed at 100%; ZBar's stricter threshold
means 70% and 50% for 15% and 30% logos respectively.

**The OPQR solution.**
OPQR Code uses *padding codewords* — bytes that exist only to fill unused
data capacity and carry no information. Because the ECC is recomputed after
embedding, no error is introduced at all. The decoder sees a fully valid
codeword stream and achieves 100% decode rate regardless of image content.

## Regenerating QR Images

> QR images in `results/` were generated with encoded text `https://opqrcode.app`.
> Regenerate with text `OPQR code` before publication:

```bash
node generate_opqr_batch.js   # creates results/opqr/ and results/dither/
node generate_comparison.js   # creates results/comparison/
```

Both scripts require Node.js 18+ and read images from `dataset/full/`.

## Running the Evaluation

Requirements: Python 3.9+, ZBar, ZXing

```bash
# Install (macOS Apple Silicon)
brew install zbar
pip install pyzbar zxing-cpp pillow

# Evaluate
DYLD_LIBRARY_PATH=/opt/homebrew/lib python3 evaluate_qr.py \
  --opqr    results/opqr \
  --dither  results/dither \
  --compare results/comparison \
  --output  eval_results.json
```

On Linux / x86 macOS, omit `DYLD_LIBRARY_PATH`.

## eval_results.json Schema

```json
{
  "opqr": {
    "label": "opqr",
    "expected": "OPQR code",
    "records": [
      {
        "id": "01_heart",
        "version": "v07",
        "noise_pct": 0,
        "file": "01_heart/01_heart_v07_noise00.png",
        "pyzbar": "OPQR code",
        "zxing": "OPQR code",
        "pyzbar_ok": true,
        "zxing_ok": true
      },
      ...
    ]
  },
  "dither": { ... },
  "compare": { ... }
}
```

## Physical Evaluation Protocol (Phase 2/3 — TBD)

See `experiment_plan.md` for planned print+scan and camera evaluation protocols.
Results will be added to this repository upon completion.
