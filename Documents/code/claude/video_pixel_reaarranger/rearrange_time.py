#!/usr/bin/env python3
"""
Video Time Rearranger
Each tile keeps its original position but plays the video at a different
temporal offset. The output is shorter than the input by --max-offset seconds.
"""

import argparse
import subprocess
import sys

import cv2
import numpy as np


def parse_args():
    p = argparse.ArgumentParser(
        description=(
            "Time-shift video tiles: each tile plays the same video at a different "
            "temporal offset. Output duration = input duration − max-offset seconds."
        )
    )
    p.add_argument("--input",      "-i", required=True,       help="Input video path")
    p.add_argument("--output",     "-o", required=True,       help="Output video path")
    p.add_argument("--tile-size",  "-t", type=int,   default=50,  help="Square tile size in pixels (default: 50)")
    p.add_argument("--max-offset", "-m", type=float, default=2.0, help="Max temporal offset in seconds (default: 2.0)")
    p.add_argument("--seed",       "-s", type=int,   default=None, help="Random seed for reproducibility")
    return p.parse_args()


def open_capture(path):
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        print(f"Error: cannot open video '{path}'", file=sys.stderr)
        sys.exit(1)
    width    = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height   = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps      = cap.get(cv2.CAP_PROP_FPS)
    n_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    return cap, width, height, fps, n_frames


def compute_crop_dims(h, w, tile_size):
    return (h // tile_size) * tile_size, (w // tile_size) * tile_size


def open_ffmpeg_pipe(output, w, h, fps):
    cmd = [
        "ffmpeg", "-y",
        "-f", "rawvideo", "-vcodec", "rawvideo",
        "-pix_fmt", "bgr24",
        "-s", f"{w}x{h}",
        "-r", str(fps),
        "-i", "pipe:0",
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-preset", "fast", "-crf", "18",
        output,
    ]
    return subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)


def assemble_time_shifted_frame(buf_array, buf_head, tile_offsets, n_rows, n_cols, tile_size, crop_h, crop_w):
    """
    For each tile, pull the tile-region from the buffer frame at that tile's offset.

    buf_array   : (buf_size, crop_h, crop_w, 3) circular buffer; already cropped
    buf_head    : circular-buffer index corresponding to offset=0 (current time)
    tile_offsets: (n_tiles,) integer offsets in [0, max_offset_frames]
    """
    buf_size = buf_array.shape[0]
    n_tiles  = n_rows * n_cols

    out_tiles = np.empty((n_tiles, tile_size, tile_size, 3), dtype=np.uint8)

    # Process one source frame per unique offset value
    for o in np.unique(tile_offsets):
        idx = (buf_head + o) % buf_size
        src_tiles = (buf_array[idx]
                     .reshape(n_rows, tile_size, n_cols, tile_size, 3)
                     .transpose(0, 2, 1, 3, 4)
                     .reshape(n_tiles, tile_size, tile_size, 3))
        mask = tile_offsets == o
        out_tiles[mask] = src_tiles[mask]

    out = (out_tiles
           .reshape(n_rows, n_cols, tile_size, tile_size, 3)
           .transpose(0, 2, 1, 3, 4)
           .reshape(crop_h, crop_w, 3))
    return np.ascontiguousarray(out, dtype=np.uint8)


def main():
    args = parse_args()

    cap, width, height, fps, n_frames = open_capture(args.input)

    tile_size = args.tile_size
    if tile_size <= 0:
        print("Error: tile size must be a positive integer.", file=sys.stderr)
        sys.exit(1)

    crop_h, crop_w = compute_crop_dims(height, width, tile_size)
    if crop_h == 0 or crop_w == 0:
        print(f"Error: tile size {tile_size}px is too large for frame size {width}x{height}.", file=sys.stderr)
        sys.exit(1)

    max_offset_frames = max(1, int(round(args.max_offset * fps)))
    buf_size = max_offset_frames + 1  # holds offsets 0 .. max_offset_frames

    if n_frames > 0 and buf_size >= n_frames:
        print(
            f"Error: --max-offset {args.max_offset}s ({max_offset_frames} frames) is "
            f">= video length ({n_frames} frames). Use a smaller value.",
            file=sys.stderr,
        )
        sys.exit(1)

    n_rows   = crop_h // tile_size
    n_cols   = crop_w // tile_size
    n_tiles  = n_rows * n_cols
    out_frames = (n_frames - max_offset_frames) if n_frames > 0 else 0
    buf_mb   = buf_size * crop_h * crop_w * 3 / 1024 / 1024

    rng = np.random.default_rng(args.seed)
    # Each tile gets a fixed integer offset drawn from [0, max_offset_frames]
    tile_offsets = rng.integers(0, max_offset_frames + 1, size=n_tiles).astype(np.intp)

    print(f"Input:        {args.input}",                                         file=sys.stderr)
    print(f"Output:       {args.output}",                                        file=sys.stderr)
    print(f"Frame size:   {width}x{height} → {crop_w}x{crop_h}",                file=sys.stderr)
    print(f"Tile size:    {tile_size}px  ({n_cols}×{n_rows} = {n_tiles} tiles)", file=sys.stderr)
    print(f"Max offset:   {args.max_offset}s  ({max_offset_frames} frames)",     file=sys.stderr)
    print(f"Output len:   {out_frames} frames  ({out_frames/fps:.2f}s)",         file=sys.stderr)
    print(f"Frame buffer: {buf_size} frames  ({buf_mb:.0f} MB)",                 file=sys.stderr)
    print(f"Seed:         {args.seed}",                                          file=sys.stderr)
    print("",                                                                    file=sys.stderr)

    # Pre-fill the circular buffer with the first buf_size frames
    buf_array = np.empty((buf_size, crop_h, crop_w, 3), dtype=np.uint8)
    print(f"Buffering {buf_size} frames...", file=sys.stderr)
    for i in range(buf_size):
        ret, frame = cap.read()
        if not ret:
            print(
                f"Error: video is shorter than --max-offset. "
                f"Reduce --max-offset below {n_frames / fps:.1f}s.",
                file=sys.stderr,
            )
            sys.exit(1)
        buf_array[i] = frame[:crop_h, :crop_w]

    buf_head = 0  # circular-buffer index of the "offset=0" (earliest) frame

    ffmpeg_proc = open_ffmpeg_pipe(args.output, crop_w, crop_h, fps)

    frame_num = 0
    try:
        while True:
            out = assemble_time_shifted_frame(
                buf_array, buf_head, tile_offsets,
                n_rows, n_cols, tile_size, crop_h, crop_w,
            )

            try:
                ffmpeg_proc.stdin.write(out.tobytes())
            except BrokenPipeError:
                print("\nError: ffmpeg pipe closed unexpectedly.", file=sys.stderr)
                break

            frame_num += 1
            if frame_num % 30 == 0:
                pct = (frame_num / out_frames * 100) if out_frames > 0 else 0
                print(f"\rProcessing: {frame_num}/{out_frames} ({pct:.1f}%)", end="", file=sys.stderr)

            # Advance: read the next source frame into the slot we just moved past
            ret, frame = cap.read()
            if not ret:
                break
            buf_array[buf_head] = frame[:crop_h, :crop_w]
            buf_head = (buf_head + 1) % buf_size

    finally:
        cap.release()
        if ffmpeg_proc.stdin:
            ffmpeg_proc.stdin.close()
        ffmpeg_proc.wait()

    if out_frames > 0:
        print(f"\rProcessing: {frame_num}/{out_frames} (100.0%)", file=sys.stderr)
    print(f"\nDone. Output: {args.output}", file=sys.stderr)


if __name__ == "__main__":
    main()
