import {env, ready, setBackend, tensor4d} from '@tensorflow/tfjs-core';
import '@tensorflow/tfjs-backend-cpu/dist/base.js';
import {loadGraphModel} from '@tensorflow/tfjs-converter';
import {setWasmPaths, setThreadsCount} from '@tensorflow/tfjs-backend-wasm/dist/base.js';
import './register-kernels.js';
import './register-wasm.js';

const side = 192;
const indices = [0,2,5,7,8,11,12,13,14,15,16,23,24,25,26,27,28];
let network;

async function getNetwork() {
  if (!network) {
    network = (async () => {
      let wasmReady = false;
      // Local single-threaded SIMD works without cross-origin isolation.
      if (typeof WebAssembly !== 'undefined') {
        try {
          env().set('WASM_HAS_MULTITHREAD_SUPPORT', false);
          setThreadsCount(1);
          const base = 'tfjs-backend-wasm.wasm';
          const vector = 'tfjs-backend-wasm-simd.wasm';
          const threaded = 'tfjs-backend-wasm-threaded-simd.wasm';
          const name = await env().getAsync('WASM_HAS_SIMD_SUPPORT') ? vector : base;
          const response = await fetch(new URL(name, self.location.href).href);
          if (!response.ok) throw Error('Missing on-device acceleration');
          const bytes = await response.arrayBuffer();
          // Verify the download before handing it to the Emscripten runtime.
          await WebAssembly.compile(bytes);
          const local = URL.createObjectURL(new Blob([bytes], {type:'application/wasm'}));
          try {
            setWasmPaths({[base]:local,[vector]:local,[threaded]:local}, true);
            wasmReady = await setBackend('wasm');
          } finally { URL.revokeObjectURL(local); }
        } catch {}
      }
      if (!wasmReady) await setBackend('cpu');
      await ready();
      return loadGraphModel(new URL('./model.json', self.location.href).href);
    })().catch(error => {
      network = undefined;
      throw error;
    });
  }
  return network;
}

function unpack(keypoints, frame) {
  const points = Array.from({length:33}, () => ({x:0,y:0,confidence:0}));
  for (let i=0; i<indices.length; i++) {
    const y = (keypoints[i*3]*side-frame.top)/frame.height;
    const x = (keypoints[i*3+1]*side-frame.left)/frame.width;
    const score = keypoints[i*3+2];
    if (Number.isFinite(x) && Number.isFinite(y) && x>=0 && x<=1 && y>=0 && y<=1 && Number.isFinite(score)) {
      points[indices[i]] = {x,y,confidence:Math.max(0,Math.min(1,score))};
    }
  }
  const torso = [11,12,23,24].map(i=>points[i]);
  if(torso[0].confidence<.45 || torso[1].confidence<.45 || Math.max(torso[2].confidence,torso[3].confidence)<.35) return null;
  return points;
}

self.onmessage = async ({data}) => {
  const {id,frame,buffer} = data;
  let input, output;
  try {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength!==side*side*4) throw Error('Invalid raster');
    const model = await getNetwork();
    const pixels = new Uint8ClampedArray(buffer);
    const rgb = new Int32Array(side*side*3);
    for(let a=0,b=0; a<pixels.length; a+=4) {
      rgb[b++]=pixels[a]; rgb[b++]=pixels[a+1]; rgb[b++]=pixels[a+2];
    }
    input=tensor4d(rgb,[1,side,side,3],'int32');
    output=model.execute(input);
    const points=unpack(await output.data(),frame);
    self.postMessage({id,points});
  } catch(error) {
    self.postMessage({id,points:null,reason:error?.message||'CPU pose unavailable'});
  } finally {
    input?.dispose();
    output?.dispose();
  }
};
