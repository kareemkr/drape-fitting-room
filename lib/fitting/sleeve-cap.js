// The sleeve cap runs from the shoulder seam to the upper arm. A flat product
// texture can leave an inward notch there even when the cuff and waist fit.
export function alignSleeveCap(rows, side, shoulders, arc, capFraction, shoulderScale) {
  if (!arc || arc.length < 3 || rows.length < 3) return;
  const [left, right] = shoulders;
  const dx = right.x - left.x, dy = right.y - left.y;
  const span = Math.hypot(dx, dy);
  if (span < 1) return;
  const midX = (right.x + left.x) / 2, midY = (right.y + left.y) / 2;
  const axisX = dx / span, axisY = dy / span;
  const sign = side === 0 ? -1 : 1;
  const last = Math.floor((rows.length - 1) * capFraction);

  for (let i = 0; i <= last; i++) {
    const row = rows[i], hemSide = row.at(-1).t;
    const px = (hemSide.x - midX) / span, py = (hemSide.y - midY) / span;
    const x = sign * (px * axisX + py * axisY);
    const y = -px * axisY + py * axisX;
    if (x < 0.5 || y < -0.32 || y > 0.25) continue;

    // The outlined stations describe the outside of the actual shoulder in
    // shoulder-width units. Grade the reference arc with the chosen size.
    let nearest = null;
    for (let j = 1; j < arc.length; j++) {
      const a = arc[j - 1], b = arc[j];
      const stationGap = b.x - a.x;
      if (!(stationGap > 0 && stationGap <= 0.081) || b.x < 0.5) continue;
      const ax = a.x * shoulderScale, vx = stationGap * shoulderScale;
      const vy = b.y - a.y;
      const t = ((x - ax) * vx + (y - a.y) * vy) / (vx * vx + vy * vy);
      if (t < -0.15 || t > 1.15) continue;
      const onSegment = Math.max(0, Math.min(1, t));
      const ox = ax + vx * onSegment - x, oy = a.y + vy * onSegment - y;
      const distance = Math.hypot(ox, oy);
      if (!nearest || distance < nearest.distance) {
        nearest = { ox, oy, distance, inside: ox * vy - oy * vx > 0 };
      }
    }
    if (!nearest?.inside || !nearest.distance || nearest.distance > 0.095) continue;

    // Leave the sewn inner edge and the source UVs in place. A subpixel
    // allowance accounts for antialiasing on the outermost fabric texels.
    const { ox, oy, distance } = nearest;
    const gain = Math.min(1.4, 1 + 0.006 / distance, 0.08 / distance);
    const offsetX = (sign * ox * axisX - oy * axisY) * span * gain;
    const offsetY = (sign * ox * axisY + oy * axisX) * span * gain;
    for (let col = 1; col < row.length; col++) {
      const vertex = row[col];
      const weight = col / (row.length - 1);
      vertex.t = { x: vertex.t.x + offsetX * weight, y: vertex.t.y + offsetY * weight };
    }
  }
}
