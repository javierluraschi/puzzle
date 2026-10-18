# Test 1 - Feedback

Testing of the current version surfaced two major problems.

## Overheating

1. The phone overheats and crashes the webpage, probably from doing continuous realtime segmentation. Might be better to only do the tilt indicator and scan the printed box (so we enforce users to have to print the scanning page) and we only run segmentation once photo is taken.

## Quality

2. The biggest problem seems to be the quality of the extraction of the edges. See photo-piece-X.HEIC, photos seem to have good resolution, but then when you look at the scans app-piece-scan-all.PNG and indivudually app-piece-scan-N.PNG the pieces edjes looks very jittery.

NOTE: Is unclear from the suggestions which one will pay off, if any and other explorations might be missing, up to you to decide.

I think there are two problems:

2.1 Jitterness: One the contour jitterness is high we might have to consider using the segment api just to estimate where the piece is but then do other traditional computer vision to extract a high quality edge.

2.2 Shadow: The shadow is being considered as part of the shape.

2.2.1 Algorithms: Explore using algorithms that can remove the shape of a piece.

2.2.2 Rotation: ASk the user to rotate the piece 180 degress as part of the scan.

2.2.3 Flash: One solution here is to request turning on the flash

