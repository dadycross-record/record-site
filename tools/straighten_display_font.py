"""Build Record Display from the original Unbounded WOFF (FontTools required)."""

import argparse
from hashlib import sha256
from pathlib import Path

from fontTools.misc.roundTools import otRound
from fontTools.ttLib import TTFont
from fontTools.ttLib.tables._g_l_y_f import GlyphCoordinates

SOURCE_SHA256 = "a0ee68d13ee6d9c45f432b7fb93e4c4f8e272d95eef48f981c43e9459c334f74"

# Each entry specifies the reference x coordinate and the points on that edge.
# Preserve the y coordinates and all curves outside the edited stem edges.
EDGES = {
    "B": [(10, (11,)), (39, (40, 20))],
    "E": [(9, (10,)), (15, (4, 5))],
    "Egrave": [(9, (10,)), (15, (4, 5))],
    "uni0400": [(9, (10,)), (15, (4, 5))],
    "uni0411": [(10, (11,)), (16, (17, 18))],
    "uni0432": [(0, (1,)), (36, (37, 17))],
    "a": [(0, (1, 2, 3, 4)), (5, (6, 7))],
    "agrave": [(0, (1, 2, 3, 4)), (5, (6, 7))],
    "d": [(0, (1, 2, 3, 4)), (5, (6, 7))],
    "ae": [(36, (37, 38, 39, 40)), (41, (42, 43))],
    "b": [(0, (8,)), (1, (2, 3, 4, 5, 6))],
    "p": [(0, (8,)), (1, (2, 3, 4, 5, 6))],
    "q": [(0, (8,)), (7, (2, 3, 4, 5, 6))],
    "glyph00132": [(0, (1, 2, 3, 4)), (5, (6, 7))],
    "ordfeminine": [(0, (1, 2, 3, 4)), (5, (6, 7))],
    "at": [(37, (33, 34, 35, 36)), (38, (39, 40))],
}


# Horizontal bars overlap the inner edge of their stem. Move the hidden
# endpoints into the straightened stem so light weights remain connected.
BAR_JOINS = {
    "B": (10, 39, (29, 30)),
    "E": (9, 15, (2, 3)),
    "Egrave": (9, 15, (2, 3)),
    "uni0400": (9, 15, (2, 3)),
    "uni0411": (10, 16, (0, 27)),
    "uni0432": (0, 36, (26, 27)),
}


def align_x(coordinates, name, edges):
    for reference, points in edges:
        x = coordinates[reference][0]
        for point in points:
            coordinates[point] = (x, coordinates[point][1])

    if name in BAR_JOINS:
        outer, inner, points = BAR_JOINS[name]
        x = otRound((coordinates[outer][0] + coordinates[inner][0]) / 2)
        for point in points:
            coordinates[point] = (x, coordinates[point][1])


def build(source, destination):
    if sha256(source.read_bytes()).hexdigest() != SOURCE_SHA256:
        raise ValueError("The contour point map requires the original repository WOFF.")

    font = TTFont(source, recalcTimestamp=False, recalcBBoxes=False)
    glyf = font["glyf"]
    for name, edges in EDGES.items():
        glyph = glyf[name]
        original, controls = glyf._getCoordinatesAndControls(name, font["hmtx"].metrics)
        revised = GlyphCoordinates(original)
        align_x(revised, name, edges)

        # Expand inferred deltas against the untouched geometry before moving points.
        # Applying the same constraint to the base and every delta keeps it exact
        # throughout the weight axis, including intermediate instances.
        for variation in font["gvar"].variations[name]:
            variation.calcInferredDeltas(original, controls.endPts)
            deltas = list(variation.coordinates)
            align_x(deltas, name, edges)
            variation.coordinates = deltas

        glyph.coordinates = GlyphCoordinates(revised[:-4])
        glyph.recalcBounds(glyf)

    display_names = {
        1: "Record Display",
        3: "1.701;RECORD;RecordDisplay-Regular",
        4: "Record Display Regular",
        6: "RecordDisplay-Regular",
    }
    for name in font["name"].names:
        if name.nameID in display_names:
            name.string = display_names[name.nameID]

    font.save(destination)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    build(args.source, args.destination)
