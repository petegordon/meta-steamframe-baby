// Copies MediaPipe's WASM runtime into public/ so the app works offline on the headset.
import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../node_modules/@mediapipe/tasks-vision/wasm', import.meta.url));
const dest = fileURLToPath(new URL('../public/mediapipe', import.meta.url));
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log('[copy-mediapipe] wasm ->', dest);
