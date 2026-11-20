# Live MoveNet worker

The camera worker runs the same Google MoveNet Lightning graph as the photo worker.
It uses the TensorFlow.js single-thread WASM SIMD or scalar kernels when available.
These local files work without cross-origin isolation. A separate JavaScript CPU
worker supports browsers that cannot initialize WASM.

To rebuild from this directory with Node and npm:

```sh
npm install --no-save --ignore-scripts @tensorflow/tfjs-core@4.22.0 @tensorflow/tfjs-converter@4.22.0 @tensorflow/tfjs-backend-cpu@4.22.0 @tensorflow/tfjs-backend-wasm@4.22.0 esbuild@0.25.12
./node_modules/.bin/esbuild live-entry.js --bundle --format=iife --platform=browser --target=es2020 --minify --legal-comments=external --outfile=../../public/pose-cpu/live-worker.js
cp node_modules/@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm.wasm ../../public/pose-cpu/
cp node_modules/@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-simd.wasm ../../public/pose-cpu/
```

Use the Apache-2.0 license at `public/pose-cpu/LICENSE` and the bundled
`live-worker.js.LEGAL.txt` notice. The SIMD/scalar runtimes are distributed by
`@tensorflow/tfjs-backend-wasm@4.22.0`. The model attribution and upstream source
are listed in `public/pose-cpu/SOURCES.txt`.
