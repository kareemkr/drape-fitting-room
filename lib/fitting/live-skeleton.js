// Shared MediaPipe indices. The MoveNet fallback fills only the joints it
// observes; the same confidence check omits unsupported hands and toes.
const connections = [
  [7, 2], [2, 0], [0, 5], [5, 8],
  [11, 12], [11, 13], [13, 15], [15, 19],
  [12, 14], [14, 16], [16, 20],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [27, 31],
  [24, 26], [26, 28], [28, 32],
];
const joints = [...new Set(connections.flat())];

function visible(point) {
  return (
    point && Number.isFinite(point.x) && Number.isFinite(point.y) &&
    point.x > 0 && point.x < 1 && point.y > 0 && point.y < 1 &&
    (point.confidence ?? point.visibility ?? 0) >= 0.48
  );
}

export function clearLiveSkeleton(canvas) {
  const context = canvas?.getContext("2d");
  if (context) context.clearRect(0, 0, canvas.width, canvas.height);
}

// Draw into a dedicated transparent layer with the video’s native aspect ratio.
// The caller applies the same CSS mirror to the video and both overlay canvases.
export function drawLiveSkeleton(canvas, points, rings) {
  const context = canvas?.getContext("2d");
  if (!context) return;
  const { width, height } = canvas;
  context.clearRect(0, 0, width, height);
  if (!points || !visible(points[11]) || !visible(points[12])) return;
  const unit = Math.max(0.8, Math.min(2, Math.min(width, height) / 440));
  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  for (const [a, b] of connections) {
    const from = points[a], to = points[b];
    if (!visible(from) || !visible(to)) continue;
    context.moveTo(from.x * width, from.y * height);
    context.lineTo(to.x * width, to.y * height);
  }
  // Connect the face to the center of the shoulder line, without inventing
  // a tracked joint in the neck.
  if (visible(points[0])) {
    context.moveTo(points[0].x * width, points[0].y * height);
    context.lineTo(
      (points[11].x + points[12].x) * width / 2,
      (points[11].y + points[12].y) * height / 2,
    );
  }
  context.strokeStyle = "rgba(35, 29, 58, .82)";
  context.lineWidth = 3.7 * unit;
  context.stroke();
  context.strokeStyle = "rgba(196, 233, 232, .97)";
  context.lineWidth = 1.6 * unit;
  context.stroke();

  context.beginPath();
  for (const index of joints) {
    const point = points[index];
    if (!visible(point)) continue;
    const radius = (index < 11 ? 2.2 : 3) * unit;
    const x = point.x * width, y = point.y * height;
    context.moveTo(x + radius, y);
    context.arc(x, y, radius, 0, 2 * Math.PI);
  }
  context.fillStyle = "#e3dbff";
  context.fill();
  context.strokeStyle = "#4c386a";
  context.lineWidth = 1.4 * unit;
  context.stroke();
  if (rings) {
    for (const [name, color] of [["waist", "#ffca7a"], ["hem", "#f5a4cc"]]) {
      const line = rings[name];
      if (line?.length !== 3 || !line.every((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y))) continue;
      context.beginPath();
      context.moveTo(line[0].x, line[0].y);
      context.lineTo(line[1].x, line[1].y);
      context.lineTo(line[2].x, line[2].y);
      context.setLineDash([4 * unit, 3 * unit]);
      context.strokeStyle = color;
      context.lineWidth = 1.9 * unit;
      context.stroke();
      context.setLineDash([]);
      context.fillStyle = color;
      context.strokeStyle = "#443746";
      context.lineWidth = unit;
      for (const p of line) {
        context.beginPath();
        context.arc(p.x, p.y, 3.1 * unit, 0, 2 * Math.PI);
        context.fill();
        context.stroke();
      }
    }
  }
  context.restore();
}
