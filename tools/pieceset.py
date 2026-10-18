"""Helpers for the jigsawlutioner-cli sample sets (one backlit scan + one color scan per piece)."""

from collections import deque

import numpy as np


def piece_numbers(meta):
    if "numbers" in meta:
        return meta["numbers"]
    return [n for n in range(meta["min"], meta["max"] + 1) if n not in meta.get("exclude", [])]


def largest_component(mask):
    """The largest 4-connected region of a boolean mask (the piece, without dust and scanner edges)."""
    h, w = mask.shape
    labels = np.zeros(mask.shape, dtype=np.int32)
    best, best_size, label = 0, 0, 0
    for y, x in zip(*np.nonzero(mask)):
        if labels[y, x]:
            continue
        label += 1
        queue, size = deque([(y, x)]), 0
        labels[y, x] = label
        while queue:
            cy, cx = queue.popleft()
            size += 1
            for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
                if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not labels[ny, nx]:
                    labels[ny, nx] = label
                    queue.append((ny, nx))
        if size > best_size:
            best, best_size = label, size
    return labels == best
