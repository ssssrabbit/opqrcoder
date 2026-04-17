#!/usr/bin/env python3
"""
evaluate_qr.py — QRコード読み取り評価スクリプト

batch_manifest.json / comparison_manifest.json に記録された PNG 画像を
pyzbar (ZBar) と zxing-cpp の2デコーダで一括デコードし、成功率・エラー率を集計する。

Usage:
  python3 evaluate_qr.py \\
    --opqr    opqr_results/batch_manifest.json \\
    --dither  opqr_results_dither/batch_manifest.json \\
    --compare opqr_comparison/comparison_manifest.json \\
    --output  eval_results.json \\
    --table   comparison_table.md

  # 単一マニフェストのみ
  python3 evaluate_qr.py --opqr opqr_results/batch_manifest.json

Dependencies:
  pip install pyzbar zxing-cpp pillow numpy
  macOS arm64: brew install zbar  (-> /opt/homebrew/lib/libzbar.dylib)
  実行時に libzbar が見つからない場合:
    DYLD_LIBRARY_PATH=/opt/homebrew/lib python3 evaluate_qr.py ...
"""

import argparse
import json
import os
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional

import numpy as np
from PIL import Image

# ── デコーダ読み込み ──────────────────────────────────────────────────────────

try:
    from pyzbar import pyzbar as _pyzbar
    HAVE_PYZBAR = True
except Exception as e:
    print(f"[WARN] pyzbar unavailable: {e}", file=sys.stderr)
    HAVE_PYZBAR = False

try:
    import zxingcpp as _zxing
    HAVE_ZXING = True
except Exception as e:
    print(f"[WARN] zxing-cpp unavailable: {e}", file=sys.stderr)
    HAVE_ZXING = False

if not HAVE_PYZBAR and not HAVE_ZXING:
    sys.exit("[ERROR] Neither pyzbar nor zxing-cpp is available. See script header.")


# ── デコード関数 ──────────────────────────────────────────────────────────────

def decode_pyzbar(img_rgba: Image.Image) -> Optional[str]:
    """pyzbar (ZBar) で QR コードをデコード。失敗時は None。"""
    if not HAVE_PYZBAR:
        return None
    try:
        results = _pyzbar.decode(img_rgba)
        if results:
            return results[0].data.decode("utf-8", errors="replace")
    except Exception:
        pass
    return None


def decode_zxing(img_gray: np.ndarray) -> Optional[str]:
    """zxing-cpp で QR コードをデコード。失敗時は None。"""
    if not HAVE_ZXING:
        return None
    try:
        results = _zxing.read_barcodes(img_gray)
        if results:
            return results[0].text
    except Exception:
        pass
    return None


def decode_image(path: str) -> dict:
    """画像ファイルをデコードし {pyzbar, zxing} の結果辞書を返す。"""
    try:
        img = Image.open(path)
        img_rgba = img.convert("RGBA")
        img_gray = np.array(img.convert("L"))
    except Exception as e:
        return {"pyzbar": None, "zxing": None, "error": str(e)}

    return {
        "pyzbar": decode_pyzbar(img_rgba),
        "zxing":  decode_zxing(img_gray),
    }


# ── 評価ロジック ──────────────────────────────────────────────────────────────

@dataclass
class DecodeRecord:
    file: str
    expected: str
    pyzbar: Optional[str] = None
    zxing: Optional[str] = None

    @property
    def pyzbar_ok(self) -> bool:
        return self.pyzbar == self.expected

    @property
    def zxing_ok(self) -> bool:
        return self.zxing == self.expected


def evaluate_batch_manifest(manifest_path: str, label: str) -> dict:
    """
    batch_manifest.json を読み込み、各画像をデコードして結果を返す。
    返り値:
      {
        "label": label,
        "records": [
          {
            "id": image_id,
            "version": "v07",
            "noise_pct": 0,
            "file": "...",
            "pyzbar": "https://...",
            "zxing": "https://...",
            "pyzbar_ok": True,
            "zxing_ok": True
          }, ...
        ]
      }
    """
    manifest_path = Path(manifest_path)
    base_dir = manifest_path.parent

    with open(manifest_path) as f:
        manifest = json.load(f)

    expected_text = manifest.get("options", {}).get("text", "OPQR code")
    results_list = manifest.get("results", [])

    records = []
    total = sum(
        len(v["noise_results"])
        for item in results_list
        for v in item["versions"].values()
    )
    done = 0

    for item in results_list:
        image_id = item["id"]
        for ver, ver_data in item["versions"].items():
            for noise_entry in ver_data["noise_results"]:
                rel_file = noise_entry["file"]
                abs_path = str(base_dir / rel_file)
                decoded = decode_image(abs_path)
                done += 1
                print(f"\r  [{label}] {done}/{total} {rel_file[-40:]}", end="", flush=True)

                records.append({
                    "id":        image_id,
                    "version":   ver,
                    "noise_pct": noise_entry["noise_pct"],
                    "file":      rel_file,
                    "pyzbar":    decoded.get("pyzbar"),
                    "zxing":     decoded.get("zxing"),
                    "pyzbar_ok": decoded.get("pyzbar") == expected_text,
                    "zxing_ok":  decoded.get("zxing") == expected_text,
                })

    print()
    return {"label": label, "expected": expected_text, "records": records}


def evaluate_comparison_manifest(manifest_path: str) -> dict:
    """
    comparison_manifest.json を読み込み、各画像をデコードして結果を返す。
    """
    manifest_path = Path(manifest_path)
    base_dir = manifest_path.parent

    with open(manifest_path) as f:
        manifest = json.load(f)

    expected_text = manifest.get("text", "OPQR code")
    results_list = manifest.get("results", [])

    records = []
    total = sum(
        len(v["method_results"])
        for item in results_list
        for v in item["versions"].values()
    )
    done = 0

    for item in results_list:
        image_id = item["id"]
        for ver, ver_data in item["versions"].items():
            for method_entry in ver_data["method_results"]:
                rel_file = method_entry["file"]
                abs_path = str(base_dir / rel_file)
                decoded = decode_image(abs_path)
                done += 1
                print(f"\r  [comparison] {done}/{total} {rel_file[-40:]}", end="", flush=True)

                records.append({
                    "id":           image_id,
                    "version":      ver,
                    "method_id":    method_entry["method_id"],
                    "method":       method_entry["method"],
                    "ecl":          method_entry.get("ecl", "L"),
                    "file":         rel_file,
                    "override_count": method_entry.get("overrideCount", 0),
                    "override_ratio": method_entry.get("overrideRatio", 0),
                    "within_capacity": method_entry.get("withinCapacity", True),
                    "pyzbar":       decoded.get("pyzbar"),
                    "zxing":        decoded.get("zxing"),
                    "pyzbar_ok":    decoded.get("pyzbar") == expected_text,
                    "zxing_ok":     decoded.get("zxing") == expected_text,
                })

    print()
    return {"label": "comparison", "expected": expected_text, "records": records}


# ── 集計 ─────────────────────────────────────────────────────────────────────

def success_rate(records: list, key: str = "pyzbar_ok") -> float:
    """records リスト中の key が True の割合（%）を返す。"""
    if not records:
        return float("nan")
    return sum(1 for r in records if r[key]) / len(records) * 100


def fmt_rate(rate: float, n: int) -> str:
    if rate != rate:  # nan
        return "N/A"
    return f"{rate:.1f}% ({int(round(rate * n / 100))}/{n})"


# ── Markdown テーブル生成 ─────────────────────────────────────────────────────

TBD = "TBD"

# 比較方式の表示名マッピング
METHOD_LABELS = {
    "standard_L":             "標準 QR (ECL=L)",
    "center_logo_15pct_L":    "中央ロゴ 15% (ECL=L)",
    "center_logo_30pct_H":    "中央ロゴ 30% (ECL=H)",
    "ecc_overlay_limited_L":  "ECC 上書き ≤7% (ECL=L)",
    "ecc_overlay_limited_H":  "ECC 上書き ≤30% (ECL=H)",
    "ecc_overlay_full_H":     "ECC 全上書き (ECL=H)",
}

NOISE_LABELS = {
    0:  "OPQR noise=0%",
    5:  "OPQR noise=5%",
    10: "OPQR noise=10%",
    15: "OPQR noise=15%",
    20: "OPQR noise=20%",
    25: "OPQR noise=25%",
    30: "OPQR noise=30%",
}


def build_markdown_table(
    opqr_data: Optional[dict],
    dither_data: Optional[dict],
    compare_data: Optional[dict],
    versions: list = ["v07", "v10", "v20"],
) -> str:
    lines = []

    lines.append("# QRコード読み取り評価結果\n")
    lines.append(
        "- **デジタル評価**: 生成 PNG を直接デコード（ZBar / ZXing）\n"
        "- **印刷・カメラ評価**: TBD（実験計画書 `experiment_plan.md` 参照）\n"
        "- 成功率 = デコード成功数 / 試行数 × 100%\n"
        "- n = 10画像\n"
    )

    for ver in versions:
        lines.append(f"\n## バージョン {ver}\n")

        # ヘッダ
        header_cols = ["方式", "変更モジュール", "容量内?",
                       "ZBar (デジタル)", "ZXing (デジタル)",
                       "ZBar (印刷+スキャン)", "ZBar (カメラ 20cm)", "ZBar (カメラ 30° 傾き)"]
        lines.append("| " + " | ".join(header_cols) + " |")
        lines.append("| " + " | ".join(["---"] * len(header_cols)) + " |")

        # ── 標準 QR と比較手法 ──
        if compare_data:
            for method_id in ["standard_L",
                               "center_logo_15pct_L", "center_logo_30pct_H",
                               "ecc_overlay_limited_L", "ecc_overlay_limited_H",
                               "ecc_overlay_full_H"]:
                recs = [r for r in compare_data["records"]
                        if r["version"] == ver and r["method_id"] == method_id]
                if not recs:
                    continue
                n = len(recs)
                label = METHOD_LABELS.get(method_id, method_id)

                # override 情報
                first = recs[0]
                if first["override_count"] == 0:
                    override_str = "0"
                else:
                    ratio = float(first["override_ratio"]) if isinstance(first["override_ratio"], (int, float)) else float(first["override_ratio"])
                    override_str = f"{first['override_count']} ({ratio*100:.1f}%)"

                within = "✓" if first.get("within_capacity", True) else "✗ (超過)"

                zbar_rate  = success_rate(recs, "pyzbar_ok")
                zxing_rate = success_rate(recs, "zxing_ok")

                row = [
                    label,
                    override_str,
                    within,
                    fmt_rate(zbar_rate, n),
                    fmt_rate(zxing_rate, n),
                    TBD, TBD, TBD,
                ]
                lines.append("| " + " | ".join(row) + " |")

        # ── OPQR（ノイズなし＝提案手法）──
        if opqr_data:
            lines.append(f"| **--- OPQR (提案手法, dither=OFF) ---** | | | | | | | |")
            for noise_pct in [0, 5, 10, 15, 20, 25, 30]:
                recs = [r for r in opqr_data["records"]
                        if r["version"] == ver and r["noise_pct"] == noise_pct]
                if not recs:
                    continue
                n = len(recs)
                label = NOISE_LABELS.get(noise_pct, f"OPQR noise={noise_pct}%")
                zbar_rate  = success_rate(recs, "pyzbar_ok")
                zxing_rate = success_rate(recs, "zxing_ok")
                row = [
                    f"**{label}**",
                    "0 (padding領域のみ)", "✓",
                    fmt_rate(zbar_rate, n),
                    fmt_rate(zxing_rate, n),
                    TBD, TBD, TBD,
                ]
                lines.append("| " + " | ".join(row) + " |")

        # ── OPQR + dither ──
        if dither_data:
            lines.append(f"| **--- OPQR (提案手法, dither=ON) ---** | | | | | | | |")
            for noise_pct in [0, 5, 10, 15, 20, 25, 30]:
                recs = [r for r in dither_data["records"]
                        if r["version"] == ver and r["noise_pct"] == noise_pct]
                if not recs:
                    continue
                n = len(recs)
                label = NOISE_LABELS.get(noise_pct, f"OPQR noise={noise_pct}%")
                zbar_rate  = success_rate(recs, "pyzbar_ok")
                zxing_rate = success_rate(recs, "zxing_ok")
                row = [
                    f"**{label} (dither)**",
                    "0 (padding領域のみ)", "✓",
                    fmt_rate(zbar_rate, n),
                    fmt_rate(zxing_rate, n),
                    TBD, TBD, TBD,
                ]
                lines.append("| " + " | ".join(row) + " |")

    # ── 注釈 ──
    lines.append("\n---\n")
    lines.append("## 注釈\n")
    lines.append("- **ZBar (デジタル)**: `pyzbar` ライブラリ (ZBar 0.23) による PNG 直接デコード")
    lines.append("- **ZXing (デジタル)**: `zxing-cpp` 3.0 による PNG 直接デコード")
    lines.append("- **TBD**: 実験未実施。`experiment_plan.md` のプロトコルに従い後日測定")
    lines.append("- **変更モジュール**: 元の QR コードから変更されたモジュール数と全モジュール数に対する割合")
    lines.append("- **容量内?**: 変更率が誤り訂正容量 (ECL に対応する割合) 以内かどうか")
    lines.append("- OPQR 提案手法は padding 領域のみに画像を書き込むため変更モジュール = 0 (ECC への影響なし)")
    lines.append("")

    return "\n".join(lines)


# ── メイン ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="QRコード読み取り評価スクリプト")
    parser.add_argument("--opqr",    help="batch_manifest.json (dither OFF)", default=None)
    parser.add_argument("--dither",  help="batch_manifest.json (dither ON)",  default=None)
    parser.add_argument("--compare", help="comparison_manifest.json",          default=None)
    parser.add_argument("--output",  help="評価結果 JSON 出力先",              default="eval_results.json")
    parser.add_argument("--table",   help="比較表 Markdown 出力先",            default="comparison_table.md")
    parser.add_argument("--versions", nargs="+", default=["v07", "v10", "v20"],
                        help="評価する QR バージョン (例: v07 v10)")
    args = parser.parse_args()

    if not any([args.opqr, args.dither, args.compare]):
        parser.error("--opqr, --dither, --compare のいずれか1つ以上を指定してください。")

    all_results = {}

    if args.opqr:
        print(f"[1/3] OPQR (dither OFF): {args.opqr}")
        all_results["opqr"] = evaluate_batch_manifest(args.opqr, "opqr")

    if args.dither:
        print(f"[2/3] OPQR (dither ON): {args.dither}")
        all_results["dither"] = evaluate_batch_manifest(args.dither, "dither")

    if args.compare:
        print(f"[3/3] Comparison: {args.compare}")
        all_results["compare"] = evaluate_comparison_manifest(args.compare)

    # JSON 保存
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(all_results, f, ensure_ascii=False, indent=2)
    print(f"\n[OK] 評価結果を保存: {args.output}")

    # サマリ表示
    print("\n=== サマリ ===")
    for key, data in all_results.items():
        recs = data["records"]
        for ver in args.versions:
            v_recs = [r for r in recs if r["version"] == ver]
            if not v_recs:
                continue
            zbar  = success_rate(v_recs, "pyzbar_ok")
            zxing = success_rate(v_recs, "zxing_ok")
            pyzbar_str = f"ZBar={zbar:.1f}%" if zbar == zbar else "ZBar=N/A"
            zxing_str  = f"ZXing={zxing:.1f}%" if zxing == zxing else "ZXing=N/A"
            print(f"  [{key}] {ver}: {pyzbar_str}  {zxing_str}  (n={len(v_recs)})")

    # Markdown テーブル
    md = build_markdown_table(
        opqr_data    = all_results.get("opqr"),
        dither_data  = all_results.get("dither"),
        compare_data = all_results.get("compare"),
        versions     = args.versions,
    )
    with open(args.table, "w", encoding="utf-8") as f:
        f.write(md)
    print(f"[OK] 比較表を保存: {args.table}")


if __name__ == "__main__":
    main()
