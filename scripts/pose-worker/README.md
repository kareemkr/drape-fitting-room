# CPU pose worker

The model is Google's MoveNet SinglePose Lightning v4 for TensorFlow.js. The
browser downloads this fallback only when needed. The model returns 17 COCO
keypoints at 192 × 192 resolution, which the worker maps to the public
33-index pose interface. Only 23 kernels needed for the graph and its execution
helpers are registered. No WebGL, GPU runtime, canvas, or DOM is required in
the worker.

To rebuild the JavaScript bundle from this directory with Node and npm:

```sh
npm install --no-save --ignore-scripts @tensorflow/tfjs-core@4.22.0 @tensorflow/tfjs-converter@4.22.0 @tensorflow/tfjs-backend-cpu@4.22.0 esbuild@0.25.12
./node_modules/.bin/esbuild cpu-entry.js --bundle --minify --format=iife --platform=browser --target=es2020 --legal-comments=external --outfile=../../public/pose-cpu/worker.js
```

The two model shards and model.json come from the v4 Kaggle release listed in
`public/pose-cpu/SOURCES.txt`. Serve all files from the same `/pose-cpu/` directory.

After changing an allowlisted model, worker or Wasm binary, run
`node scripts/pose-worker/refresh-cache.mjs --write` from the project root. This
refreshes the SHA-256 allowlist and its browser cache version. Run the command
without `--write` to check that the version matches the shipped files.
