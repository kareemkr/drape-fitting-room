import {ready, setBackend, tensor4d} from '@tensorflow/tfjs-core';
import '@tensorflow/tfjs-backend-cpu/dist/base.js';
import {loadGraphModel} from '@tensorflow/tfjs-converter';
import './register-kernels.js';

const side = 192;
const indices = [0,2,5,7,8,11,12,13,14,15,16,23,24,25,26,27,28];
let network;

async function getNetwork() {
  if (!network) {
    network = (async () => {
      await setBackend('cpu');
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
