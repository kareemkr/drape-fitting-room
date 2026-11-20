export const samples = [
  {
    id: "denim",
    name: "Denim Trucker Jacket",
    label: "Outerwear",
    tone: "#e8ebf0",
  },
  { id: "knit", name: "Ribbed Crewneck", label: "Knitwear", tone: "#ede9e1" },
  {
    id: "leather",
    name: "Leather Biker Jacket",
    label: "Outerwear",
    tone: "#ebe8ed",
  },
  {
    id: "shirt",
    name: "Striped Oxford Shirt",
    label: "Shirting",
    tone: "#e6edf1",
  },
  {
    id: "trousers",
    name: "Wide-leg Trousers",
    label: "Trousers",
    category: "bottom",
    tone: "#e7e4df",
  },
  {
    id: "dress",
    name: "Floral Midi Dress",
    label: "Dresses",
    category: "dress",
    tone: "#e6e9f0",
  },
  {
    id: "skirt",
    name: "Pleated Midi Skirt",
    label: "Skirts",
    category: "bottom",
    tone: "#e8e3dc",
  },
  {
    id: "jumpsuit",
    name: "Belted Jumpsuit",
    label: "One-pieces",
    category: "dress",
    tone: "#e2e7df",
  },
].map((piece) => ({
  ...piece,
  brand: "Studio collection",
  category: piece.category || "top",
  hasStudioRender: !piece.category,
  src: "/studio/" + piece.id + ".webp",
  studio: true,
}));
export const baseModel = "/studio/male-base.webp";
export const studioModels = [
  { name: "Omar", src: baseModel, key: "male" },
  { name: "Maya", src: "/studio/model-base.webp", key: "female" },
];
export const initialFit = {
  scale: 1,
  shoulderScale: 1,
  torsoScale: 1,
  lengthScale: 1,
  sleeveScale: 1,
  dx: 0,
  dy: 0,
  rotation: 0,
  removeBackground: true,
};
export const categoryLabels = {
  top: "Top",
  bottom: "Bottom",
  dress: "One-piece",
};
