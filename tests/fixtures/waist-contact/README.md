# Waist-contact photo regressions

Run `node scripts/verify-hand-poses.mjs` after installing the repository's locked dependencies. The check decodes the supplied JPEGs locally with Sharp. It uses the production hand matte, the Striped Oxford Shirt cutout, and the production shirt mesh.

The four original synthetic studio portraits depict two adult subjects in two poses each. They are four quadrant crops of the same generated photo sheet, exported at 512 × 768 pixels with JPEG quality 96 and 4:4:4 chroma sampling. The images contain no virtual garment or mask. These are also the source portraits for `public/camera/waist-poses.mp4`.

Each record in `poses.json` contains 33 normalized MediaPipe Pose Landmarker Lite predictions in model order. Each tuple holds `[x, y, z, confidence]` and confidence is the minimum of visibility and presence. The model ran once in IMAGE mode on each saved JPEG at its native dimensions, with a two-person limit and detection, presence and tracking thresholds of 0.50. Each case returned one person. Values are rounded to six decimal places with no manual correction. The model asset at `public/pose-assets/pose_landmarker_lite.task` has SHA-256 `59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a`.

The hand and textile marks were chosen manually from the source portraits, independently of the predicted joints and matte. Coordinate pairs are native source-pixel indices from the upper left. The 33 hand marks sample visible skin in front of the original top. The 32 textile marks sample the original fabric near the hands, including finger gaps where visible.

The script requires each hand mark to have foreground alpha of at least 230/255 and each textile mark to have at most 25/255. It uses pixel-center bilinear resampling of each requested image region, followed by alpha compositing where two hand masks overlap. A separate motion check moves the arms of each measured pose and requires the shirt sleeves to respond while all three waist and all three hem anchors stay fixed. These checks measure foreground labels at 65 visible pixels and mesh attachment behavior. Full-outline accuracy and live camera behavior require additional evaluation.

As a regression check, the previous geometric hand cutout in commit `4320ece` passed 3 of the 33 hand marks and 32 of the 32 textile marks when drawn on a solid layer. The current matte passed all 65 marks.
