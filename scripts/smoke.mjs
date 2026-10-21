// Headless smoke test: page loads, MediaPipe starts in the worker, and inside
// an emulated XR session (IWER) synthetic camera hands show up as standard
// WebXR hand input sources with working joint poses and pinch -> select events.
//
//   npm run dev:runtime   (in another terminal)
//   node scripts/smoke.mjs [url]
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'https://localhost:8081/?mode=replace';
const browser = await chromium.launch({
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  if (/camera-hands|smoke/.test(m.text())) console.log('  [page]', m.text());
});

const step = (s) => console.log(`\n▶ ${s}`);
try {
  step('load');
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.cameraHands, null, { timeout: 30000 });
  console.log('  app ready');

  step('start camera (fake device) + MediaPipe worker');
  await page.click('[data-id="cam"]');
  await page.waitForFunction(() => ['running', 'error'].includes(window.cameraHands.tracker.status.state), null, { timeout: 60000 });
  // First GPU inference compiles shaders (can take several seconds).
  await page.waitForFunction(() => window.cameraHands.tracker.status.fps > 0, null, { timeout: 30000 }).catch(() => {});
  const st = await page.evaluate(() => window.cameraHands.tracker.status);
  console.log('  status:', JSON.stringify(st));
  if (st.state !== 'running') throw new Error('tracker did not start');
  if (st.fps === 0) console.log('  (fps 0 - no frames processed yet?)');

  step('enter emulated XR');
  await page.click('[data-id="vr"]');
  await page.waitForFunction(() => window.demo.world.session && window.cameraHands.polyfill?.anchor, null, { timeout: 20000 });
  await page.waitForTimeout(500);
  console.log('  session up; native sources:', await page.evaluate(() =>
    Array.from(window.demo.world.session.inputSources).map((s) => `${s.handedness}:${s.hand ? 'hand' : 'controller'}`).join(', ')));

  step('feed synthetic detections (right hand, open, ~40 cm ahead)');
  // A hand shape projected into a 640x480, 100° camera, like MediaPipe would report it.
  await page.evaluate(() => {
    const world = [{ x: 0, y: 0.06, z: 0 }];
    for (let i = 1; i <= 4; i++) world.push({ x: -0.02 - i * 0.015, y: 0.05 - i * 0.015, z: -0.005 * i });
    for (const x of [-0.025, -0.005, 0.015, 0.033]) for (let k = 0; k < 4; k++) world.push({ x, y: -k * 0.025, z: 0.002 * k });
    const fx = 320 / Math.tan((100 * Math.PI) / 360);
    window.__smoke = { world, pinch: false };
    const project = (w, t) => w.map((p) => ({ x: (fx * ((p.x + t.x) / (p.z + t.z)) + 320) / 640, y: (fx * ((p.y + t.y) / (p.z + t.z)) + 240) / 480, z: 0 }));
    setInterval(() => {
      const w = window.__smoke.world.map((p) => ({ ...p }));
      if (window.__smoke.pinch) w[4] = { ...w[8] }; // thumb tip onto index tip
      const T = { x: 0.1, y: 0.1, z: 0.4 };
      window.cameraHands.tracker.onObservation({ type: 'result', t: performance.now(), width: 640, height: 480, ms: 1,
        hands: [{ label: 'Left', score: 0.95, image: project(w, T), world: w }] }); // 'Left' = right hand (raw frames)
    }, 33);
    window.__selects = [];
    for (const t of ['selectstart', 'select', 'selectend'])
      window.demo.world.session.addEventListener(t, (e) => window.__selects.push(`${t}:${e.inputSource?.handedness}:${e.inputSource?.cameraHand ? 'camera' : 'native'}`));
  });
  // The page may still be busy warming up the GPU; wait for the hand rather than a fixed time.
  await page.waitForFunction(() => Array.from(window.demo.world.session.inputSources).some((s) => s.cameraHand), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(300);
  const r1 = await page.evaluate(() => {
    const session = window.demo.world.session;
    const srcs = Array.from(session.inputSources).map((s) => `${s.handedness}:${s.hand ? 'hand' : 'controller'}${s.cameraHand ? '(camera)' : ''}`);
    const sk = window.demo.skel.right.root;
    const h = window.cameraHands.hands.right;
    return {
      sources: srcs.join(', '),
      presented: window.cameraHands.presented,
      skeletonVisible: sk.visible,
      wristInAnchor: Array.from(h.joints.slice(12, 15)).map((v) => +v.toFixed(3)),
      pinchRatio: +h.pinch.toFixed(2),
    };
  });
  console.log('  ', JSON.stringify(r1, null, 1).replace(/\n/g, '\n   '));
  if (!r1.sources.includes('(camera)')) throw new Error('camera hand not injected into session.inputSources');
  if (!r1.skeletonVisible) throw new Error('frame.getJointPose did not return poses for the camera hand');

  step('pinch -> select events');
  await page.evaluate(() => (window.__smoke.pinch = true));
  await page.waitForTimeout(400);
  await page.evaluate(() => (window.__smoke.pinch = false));
  await page.waitForTimeout(400);
  const selects = await page.evaluate(() => window.__selects);
  console.log('  events:', selects.join(' '));
  if (!selects.includes('selectstart:right:camera') || !selects.includes('selectend:right:camera')) throw new Error('no select events');

  step('IWSDK sees the hand (its input manager + hand visual)');
  const iw = await page.evaluate(() => {
    const input = window.demo.world.input ?? window.demo.input;
    const src = input?.getPrimaryInputSource?.('right');
    return { primaryRightIsCamera: !!src?.cameraHand, visual: !!input?.visualAdapters?.hand?.right?.connected };
  });
  console.log('  ', JSON.stringify(iw));

  await page.screenshot({ path: '.tmp-smoke.png' });
  console.log('\nscreenshot: .tmp-smoke.png');
} catch (e) {
  console.error('\n✗', e.message);
  process.exitCode = 1;
} finally {
  const relevant = errors.filter((e) => !/favicon|DevTools/.test(e));
  console.log(`\npage errors (${relevant.length}):`);
  relevant.slice(0, 15).forEach((e) => console.log('  ', e.slice(0, 300)));
  await browser.close();
}
