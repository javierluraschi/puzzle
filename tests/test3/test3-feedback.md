# Test 3 - Feedback

We ran the algorithm on a real puzzle 1000 pieces for about 150 pieces that are clustered by color so matching should be possible in many cases, probably about 30-70% of pieces should match with something.

## Matching

Take a look at app-matching-f-pieces.PNG F1, F2, and F3 actually match but #70 does not. Notice that app-matching-f-pieces-percent.PNG show high edge matching but this is not enough information to properly place a piece, spatial component of their surroundings is also important.

Improvements to perform:

1.1 Threshold: I believe the matching threshold should be a bit higher or the algorithm improved, the shape of the pieces (the photo scans to edge conversion) seems good enough but the matching is reasonable but not great.

1.2 Spatial Matching: Looks to me the biggest improvement we can make is in terms of actually aligning pieces in the grid spatially, if we are matching just by pairs of edges we are loosing information since it's clear from the photos and peices contours that once the size of the piece is taken into consideration as we connect pieces, some peices clearly do not fit well with other pieces in the grid. So I think as we match pieces by edge we need to consider where the new edge is spatially situated and as we match more pieces we need to consider not just the pair being matched but also the space they take on the grid and if there is correct overlapping with other neiboring pieces. I think we can assume puzzles are a grid with 4 neighbors each if this makes the puzzle engine easier.