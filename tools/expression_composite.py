#!/usr/bin/env python3
"""표정 바리에이션 합성: 원본 + 생성본 + 마스크 -> 합성 -> 색 맞춤 -> 팔레트 고정.

사용법:
  python3 tools/expression_composite.py 원본.png 생성본.png 마스크.png 결과.png [옵션]

마스크는 흰색(밝은 곳)이 바꿀 영역(눈·눈썹·입)이고 검정이 보존 영역이에요.
순서:
  1. 마스크 밖은 전부 원본 그대로 (생성본의 전체 색 변화를 차단)
  2. 마스크 바로 바깥 고리(ring)에서 원본/생성본의 색 분포를 비교해 채널별 히스토그램 매칭
  3. 페더링한 마스크로 원본 위에 합성
  4. 원본 팔레트로 양자화 (도트풍이면 미세한 색 차이 흡수)
"""
import argparse
import sys

import numpy as np
from PIL import Image, ImageFilter


def load_rgb(path, size=None):
    img = Image.open(path).convert("RGB")
    if size and img.size != size:
        img = img.resize(size, Image.LANCZOS)
    return img


def load_mask(path, size, threshold=128):
    m = Image.open(path).convert("L")
    if m.size != size:
        m = m.resize(size, Image.NEAREST)
    return m.point(lambda v: 255 if v >= threshold else 0)


def ring_region(mask, width):
    """마스크 바깥 width 픽셀 고리 (bool 배열)."""
    k = width * 2 + 1
    grown = mask.filter(ImageFilter.MaxFilter(k if k % 2 else k + 1))
    return (np.array(grown) > 0) & ~(np.array(mask) > 0)


def match_channel(src, ref):
    """src 분포가 ref 분포를 따르도록 하는 256-엔트리 LUT."""
    s_hist = np.bincount(src, minlength=256).astype(np.float64)
    r_hist = np.bincount(ref, minlength=256).astype(np.float64)
    s_cdf = np.cumsum(s_hist) / max(s_hist.sum(), 1)
    r_cdf = np.cumsum(r_hist) / max(r_hist.sum(), 1)
    return np.interp(s_cdf, r_cdf, np.arange(256)).round().astype(np.uint8)


def color_match(orig, gen, mask, ring_px):
    """고리 영역의 원본/생성본 색을 비교해 생성본 전체에 적용."""
    ring = ring_region(mask, ring_px)
    if ring.sum() < 64:  # 고리가 너무 작으면 보정 생략
        return gen
    o, g = np.array(orig), np.array(gen)
    out = g.copy()
    for c in range(3):
        lut = match_channel(g[..., c][ring], o[..., c][ring])
        out[..., c] = lut[g[..., c]]
    return Image.fromarray(out)


def build_palette(orig, colors):
    px = np.array(orig).reshape(-1, 3)
    uniq = np.unique(px, axis=0)
    if len(uniq) <= colors:
        return uniq
    q = orig.quantize(colors=colors, method=Image.MEDIANCUT)
    pal = np.array(q.getpalette()[: colors * 3], dtype=np.uint8).reshape(-1, 3)
    return np.unique(pal, axis=0)


def snap_to_palette(img, palette, chunk=200_000):
    px = np.array(img).reshape(-1, 3).astype(np.int32)
    pal = palette.astype(np.int32)
    out = np.empty_like(px)
    for i in range(0, len(px), chunk):
        d = ((px[i:i + chunk, None, :] - pal[None, :, :]) ** 2).sum(-1)
        out[i:i + chunk] = pal[d.argmin(1)]
    return Image.fromarray(out.reshape(np.array(img).shape).astype(np.uint8))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("original")
    ap.add_argument("generated")
    ap.add_argument("mask")
    ap.add_argument("output")
    ap.add_argument("--feather", type=float, default=2.0, help="마스크 경계 블러 반경(px). 도트풍이면 0")
    ap.add_argument("--ring", type=int, default=12, help="색 맞춤 기준으로 쓸 마스크 바깥 고리 두께(px)")
    ap.add_argument("--no-match", action="store_true", help="히스토그램 매칭 생략")
    ap.add_argument("--colors", type=int, default=0, help="팔레트 최대 색 수. 0이면 팔레트 고정 생략, 원본 고유색이 이 값 이하면 그대로 사용")
    args = ap.parse_args()

    orig = load_rgb(args.original)
    gen = load_rgb(args.generated, orig.size)
    mask = load_mask(args.mask, orig.size)
    if not np.array(mask).any():
        sys.exit("마스크가 비어 있어요 (흰색 영역이 없음).")

    if not args.no_match:
        gen = color_match(orig, gen, mask, args.ring)

    alpha_img = mask.filter(ImageFilter.GaussianBlur(args.feather)) if args.feather > 0 else mask
    a = (np.array(alpha_img).astype(np.float32) / 255.0)[..., None]
    comp = np.array(orig).astype(np.float32) * (1 - a) + np.array(gen).astype(np.float32) * a
    result = Image.fromarray(comp.round().astype(np.uint8))

    if args.colors > 0:
        result = snap_to_palette(result, build_palette(orig, args.colors))

    result.save(args.output)
    print(f"저장: {args.output}")


if __name__ == "__main__":
    main()
