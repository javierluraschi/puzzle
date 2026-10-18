# Test 2 - Feedback

The changes performed to the app capture significantly improve the experience. Feedback:

## Capturing

Capturing is mostly working, see app-pieces-all.PNG the pieces look mostly correct, some improvements to make this even better:

1.1. Flash: Flash seems to make an improvement, I would suggest we keep flash on in all cases

1.2. Rotation: The mechanism to rotate the piece seems to have been clucky (app crashed) and unnecesary at the moment, I would suggest we remove the 2x rotation functionality.

1.3. Tilting: I believe we could improve the capture by making the tilting even more preceise, seems to be possible to hit a flatter angle without being a problem to the user, so the recomendation here is to make the tilting target circle a smaller to get flatter scans.

1.4 Zoom: I believe we might want to encourage users to zoom-ion to the square a bit more to capture a better image of the piece. Witht he current state seems that one can take a photo from further away.

For both (1.3) and (1.4) worth having indication to the user if we don't hit the zoom / title targets in the first 5 seconds.

## Matching

The matching algorithm is partially working, tested this for 6 pieces but still has some major problems, see app-piece-matching.PNG which shows peices 1-4-6 correctly matches and also piece 3-2 correctly matched. However, piece 3 is defientely not a match neither with 3-6 nor 3-4, the match 3-4 is a maybe (but there are some overlaps) while the piece match 3-6 is completely broken.

2.1 Neighbors: My guess is taht the algorithm is matching piece by piece and ignoring how the pieces are matched with neighbors once they are matched with other pieces near-by. So the algorithm must backtrack when a piece fits one but not a neighbor and the like.

2.2 Sensitivity: My guess is that we need to match less (incrase matching threshold) since we have now increased the capturing algorithm

2.3 Technology: I believe we might be better off moving away from PHP and ahave all teh server in node (JS / Typescript or the like) since my guess is that the PHP can be rewritten and we are already improving it so likely we want to move away from PHP. Not a hard requirement but a strong suggestion.