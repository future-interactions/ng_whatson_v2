#!/usr/bin/env python3
"""
Video Pixel Rearranger
Divides each frame into square tiles, shuffles their positions, and reassembles.
"""

import argparse
import subprocess
import sys

import cv2
import numpy as np


def parse_args():
    parser = argparse.ArgumentParser(
        description="Shuffle video frames by rearranging square tiles."
    )
    parser.add_argument("--input", "-i", required=True, help="Input video path")
    parser.add_argument("--output", "-o", required=True, help="Output video path")
    parser.add_argument(
        "--tile-size", "-t", type=int, default=50, help="Square tile size in pixels (default: 50)"
    )
    parser.add_argument(
        "--seed", "-s", type=int, default=None, help="Random seed for reproducibility"
    )
    parser.add_argument(
        "--per-frame-shuffle",
        action="store_true",
        help="Generate a new tile permutation for each frame (flickering effect)",
    )
    return parser.parse_args()


def open_capture(path):
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        print(f"Error: cannot open video '{path}'", file=sys.stderr)
        sys.exit(1)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    return cap, width, height, fps, frame_count


def compute_crop_dims(h, w, tile_size):
    crop_h = (h // tile_size) * tile_size
    crop_w = (w // tile_size) * tile_size
    return crop_h, crop_w


def make_permutation(n_tiles, rng):
    return rng.permutation(n_tiles)


def shuffle_frame(frame, tile_size, crop_h, crop_w, perm):
    # Crop to tile-aligned dimensions
    cropped = frame[:crop_h, :crop_w]

    n_rows = crop_h // tile_size
    n_cols = crop_w // tile_size

    # Reshape into grid of tiles: (n_rows, tile_size, n_cols, tile_size, 3)
    tiles = cropped.reshape(n_rows, tile_size, n_cols, tile_size, 3)

    # Transpose to (n_rows, n_cols, tile_size, tile_size, 3)
    tiles = tiles.transpose(0, 2, 1, 3, 4)

    # Flatten tile list and apply permutation
    n_tiles = n_rows * n_cols
    tiles = tiles.reshape(n_tiles, tile_size, tile_size, 3)
    tiles = tiles[perm]

    # Reassemble: reverse the reshape/transpose
    tiles = tiles.reshape(n_rows, n_cols, tile_size, tile_size, 3)
    tiles = tiles.transpose(0, 2, 1, 3, 4)
    result = tiles.reshape(crop_h, crop_w, 3)

    return np.ascontiguousarray(result, dtype=np.uint8)


def open_ffmpeg_pipe(output, w, h, fps):
    cmd = [
        "ffmpeg", "-y",
        "-f", "rawvideo",
        "-vcodec", "rawvideo",
        "-pix_fmt", "bgr24",
        "-s", f"{w}x{h}",
        "-r", str(fps),
        "-i", "pipe:0",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-preset", "fast",
        "-crf", "18",
        output,
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)
    return proc


def process_video(cap, ffmpeg_proc, width, height, fps, frame_count, tile_size, seed, per_frame_shuffle):
    crop_h, crop_w = compute_crop_dims(height, width, tile_size)

    if crop_h == 0 or crop_w == 0:
        print(
            f"Error: tile size {tile_size} is larger than frame dimensions {width}x{height}.",
            file=sys.stderr,
        )
        sys.exit(1)

    n_rows = crop_h // tile_size
    n_cols = crop_w // tile_size
    n_tiles = n_rows * n_cols

    rng = np.random.default_rng(seed)

    # Pre-compute a single permutation if not per-frame
    fixed_perm = None if per_frame_shuffle else make_permutation(n_tiles, rng)

    frame_num = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break

        perm = make_permutation(n_tiles, rng) if per_frame_shuffle else fixed_perm
        shuffled = shuffle_frame(frame, tile_size, crop_h, crop_w, perm)

        try:
            ffmpeg_proc.stdin.write(shuffled.tobytes())
        except BrokenPipeError:
            print("Error: ffmpeg pipe closed unexpectedly.", file=sys.stderr)
            break

        frame_num += 1
        if frame_count > 0 and frame_num % 30 == 0:
            pct = frame_num / frame_count * 100
            print(f"\rProcessing: {frame_num}/{frame_count} frames ({pct:.1f}%)", end="", file=sys.stderr)

    if frame_count > 0:
        print(f"\rProcessing: {frame_num}/{frame_count} frames (100.0%)", file=sys.stderr)
    else:
        print(f"\rProcessed {frame_num} frames", file=sys.stderr)


def main():
    args = parse_args()

    cap, width, height, fps, frame_count = open_capture(args.input)

    tile_size = args.tile_size
    if tile_size <= 0:
        print(f"Error: tile size must be a positive integer.", file=sys.stderr)
        sys.exit(1)

    crop_h, crop_w = compute_crop_dims(height, width, tile_size)
    if crop_h == 0 or crop_w == 0:
        print(
            f"Error: tile size {tile_size}px is too large for frame size {width}x{height}.",
            file=sys.stderr,
        )
        sys.exit(1)

    print(f"Input:      {args.input}", file=sys.stderr)
    print(f"Output:     {args.output}", file=sys.stderr)
    print(f"Frame size: {width}x{height} → cropped to {crop_w}x{crop_h}", file=sys.stderr)
    print(f"Tile size:  {tile_size}px  ({crop_w // tile_size} x {crop_h // tile_size} = {(crop_w // tile_size) * (crop_h // tile_size)} tiles)", file=sys.stderr)
    print(f"Frames:     {frame_count}", file=sys.stderr)
    print(f"FPS:        {fps}", file=sys.stderr)
    print(f"Seed:       {args.seed}", file=sys.stderr)
    print(f"Per-frame:  {args.per_frame_shuffle}", file=sys.stderr)
    print("", file=sys.stderr)

    ffmpeg_proc = open_ffmpeg_pipe(args.output, crop_w, crop_h, fps)

    try:
        process_video(
            cap, ffmpeg_proc, width, height, fps, frame_count,
            tile_size, args.seed, args.per_frame_shuffle
        )
    finally:
        cap.release()
        if ffmpeg_proc.stdin:
            ffmpeg_proc.stdin.close()
        ffmpeg_proc.wait()

    print(f"\nDone. Output written to: {args.output}", file=sys.stderr)


if __name__ == "__main__":
    main()
