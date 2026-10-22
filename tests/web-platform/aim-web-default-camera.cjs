const assert = require('node:assert/strict');
const mouseStates = new WeakMap();

module.exports = async function aim(page, frames, targetPitch, targetYaw, keepClouds = false) {
  if (!keepClouds)
    assert.equal(await page.evaluate(() => Module._WebDefaultSceneTestMode(4)), 1);
  await frames(10);
  const bounds = await page.locator('canvas').boundingBox();
  let mouse = mouseStates.get(page);
  if (await page.evaluate(() => document.pointerLockElement?.id) !== 'canvas') {
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + bounds.height / 2;
    await page.mouse.click(x, y);
    await frames(10);
    assert.equal(await page.evaluate(() => document.pointerLockElement?.id), 'canvas');
    await page.mouse.move(x, y);
    await frames(3);
    const before = await page.evaluate(() => globalThis.__webDefaultCamera);
    const calibrationY = (((before.pitch + 540) % 360) - 180) > 0 ? 20 : -20;
    await page.mouse.move(x + 20, y + calibrationY, {steps: 4});
    await frames(6);
    const after = await page.evaluate(() => globalThis.__webDefaultCamera);
    mouse = {x: x + 20, y: y + calibrationY,
      pitchScale: (((after.pitch - before.pitch + 540) % 360) - 180) / calibrationY,
      yawScale: (((after.yaw - before.yaw + 540) % 360) - 180) / 20};
    assert([mouse.pitchScale, mouse.yawScale].every(value => Math.abs(value) > 0.01 && Math.abs(value) < 5),
      JSON.stringify({before, after}));
    mouseStates.set(page, mouse);
  }
  assert(mouse, 'The camera helper must own the locked mouse position.');
  const before = await page.evaluate(() => globalThis.__webDefaultCamera);
  let camera = before;
  for (let attempt = 0; attempt < 8; ++attempt) {
    const pitch = ((camera.pitch + 540) % 360) - 180;
    const yawDelta = ((targetYaw - camera.yaw + 540) % 360) - 180;
    if (Math.abs(targetPitch - pitch) < 2 && Math.abs(yawDelta) < 2) break;
    mouse.y += (targetPitch - pitch) / mouse.pitchScale;
    mouse.x += yawDelta / mouse.yawScale;
    await page.mouse.move(mouse.x, mouse.y, {steps: 20});
    await frames(15);
    camera = await page.evaluate(() => globalThis.__webDefaultCamera);
  }
  assert(Math.abs(((camera.pitch - targetPitch + 540) % 360) - 180) < 2 &&
    Math.abs(((targetYaw - camera.yaw + 540) % 360) - 180) < 2, JSON.stringify(camera));
  assert(Math.hypot(...['x', 'y', 'z'].map(key => camera[key] - before[key])) < 1);
};
