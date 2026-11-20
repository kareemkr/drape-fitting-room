import malePoints from "./male-landmarks.json";
import femalePoints from "./female-landmarks.json";
import maleOutline from "./male-outline.json";
import femaleOutline from "./female-outline.json";

const models = {
  male: Object.assign([...malePoints], { outline: maleOutline }),
  female: Object.assign([...femalePoints], { outline: femaleOutline }),
};
export function getStudioPoints(key) {
  return models[key] || null;
}
