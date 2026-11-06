'use strict';
const assert = require('node:assert/strict');

module.exports = function inspectTexturePair(image, view) {
  assert(view.x < 0 && view.y === 0 && view.z === 200 && view.pitch === 0 && view.yaw === 0);
  const focalLength = image.width / (2 * Math.tan(view.fov * Math.PI / 360));
  const extent = 200 * focalLength / -view.x;
  const panels = [-115, 115].map(y => {
    const left = image.width / 2 + y * focalLength / -view.x - extent / 2;
    const top = image.height / 2 - extent / 2;
    const quadrants = [];
    for (let row = 0; row < 2; ++row) for (let column = 0; column < 2; ++column) {
      const mean = [0, 0, 0];
      let count = 0;
      for (let py = Math.ceil(top + (row + 0.1) * extent / 2);
        py < top + (row + 0.9) * extent / 2; ++py)
        for (let px = Math.ceil(left + (column + 0.1) * extent / 2);
          px < left + (column + 0.9) * extent / 2; ++px) {
          assert(px >= 0 && py >= 0 && px < image.width && py < image.height);
          const offset = (py * image.width + px) * 4;
          mean.forEach((_, channel) => mean[channel] += image.data[offset + channel]);
          ++count;
        }
      quadrants.push(mean.map(value => value / count));
    }
    // The Plane asset's UV orientation places green/yellow above red/blue.
    const [green, yellow, red, blue] = quadrants;
    const colorsPresent = green[1] > Math.max(green[0], green[2]) + 4 &&
      Math.min(yellow[0], yellow[1]) > yellow[2] + 4 &&
      red[0] > Math.max(red[1], red[2]) + 4 &&
      blue[2] > Math.max(blue[0], blue[1]) + 4;
    return {left, top, extent, quadrants, colorsPresent};
  });
  const largestMeanDifference = Math.max(...panels[0].quadrants.flatMap((color, index) =>
    color.map((value, channel) => Math.abs(value - panels[1].quadrants[index][channel]))));
  // Lit boards can receive different indirect illumination, including in native UE.
  const largestChromaticityDifference = Math.max(...panels[0].quadrants.flatMap((color, index) => {
    const other = panels[1].quadrants[index];
    const total = color.reduce((a, b) => a + b), otherTotal = other.reduce((a, b) => a + b);
    return color.map((value, channel) => Math.abs(value / total - other[channel] / otherTotal));
  }));
  return {panels, largestMeanDifference, largestChromaticityDifference,
    pass: panels.every(panel => panel.colorsPresent) && largestChromaticityDifference < 0.04};
};
