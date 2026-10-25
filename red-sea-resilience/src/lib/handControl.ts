/**
 * Webcam hand tracking for the globe, built on MediaPipe Tasks Vision
 * (Apache-2.0). Loaded from a CDN at runtime so the build stays dependency-free
 * and deployable on Vercel without extra asset wiring.
 */

const VERSION = '0.10.21';
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
const MODEL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

export type HandGesture = 'none' | 'palm' | 'pinch' | 'fist';

export interface HandPoint {
  x: number;
  y: number;
  z: number;
}

export interface HandFrame {
  gesture: HandGesture;
  /** Palm centre in normalised video coordinates (0..1, y down). */
  palm: { x: number; y: number };
  /** Thumb-to-index distance relative to palm size: below ~0.55 is a pinch. */
  pinch: number;
  landmarks: HandPoint[];
}

export interface HandSession {
  stop(): void;
}

export interface StartOptions {
  video: HTMLVideoElement;
  onFrame(frame: HandFrame): void;
  onStatus(status: string): void;
}

let visionPromise: Promise<any> | null = null;
const loadVision = (): Promise<any> => {
  if (!visionPromise) {
    visionPromise = import(/* @vite-ignore */ `${CDN}/vision_bundle.mjs`);
  }
  return visionPromise;
};

const distance = (a: HandPoint, b: HandPoint) => Math.hypot(a.x - b.x, a.y - b.y);

/** Classify a single hand from its 21 landmarks. */
export function classifyHand(landmarks: HandPoint[]): { gesture: HandGesture; palm: { x: number; y: number }; pinch: number } {
  const wrist = landmarks[0];
  const middleMcp = landmarks[9];
  const palm = { x: (wrist.x + middleMcp.x) / 2, y: (wrist.y + middleMcp.y) / 2 };
  const size = Math.max(0.001, distance(wrist, middleMcp));

  const pinch = distance(landmarks[4], landmarks[8]) / size;
  const tips = [8, 12, 16, 20];
  const openness = tips.reduce((sum, i) => sum + distance(landmarks[i], wrist), 0) / (tips.length * size);

  // A finger is extended when its tip is clearly farther from the wrist than
  // its middle joint. This separates an open palm from a fist far better than
  // raw spread alone, which would confuse a closed fist with a pinch.
  const extended = tips.filter(i => distance(landmarks[i], wrist) > distance(landmarks[i - 2], wrist) * 1.12).length;

  let gesture: HandGesture = 'palm';
  if (pinch < 0.62 && extended >= 2) gesture = 'pinch';
  else if (extended <= 1 || openness < 1.7) gesture = 'fist';
  return { gesture, palm, pinch };
}

export async function startHandControl({ video, onFrame, onStatus }: StartOptions): Promise<HandSession> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera API unavailable — use HTTPS or localhost');
  }

  onStatus('Requesting camera…');
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false,
    });
  } catch {
    throw new Error('Camera blocked — allow access in your browser');
  }

  const cleanupStream = () => stream.getTracks().forEach(track => track.stop());
  video.srcObject = stream;
  video.muted = true;
  try {
    await video.play();
  } catch {
    cleanupStream();
    throw new Error('Camera preview could not start');
  }

  onStatus('Loading hand model…');
  let landmarker: any = null;
  let raf = 0;
  let stopped = false;

  try {
    const mod = await loadVision();
    const vision = await mod.FilesetResolver.forVisionTasks(`${CDN}/wasm`);
    const options = {
      baseOptions: { modelAssetPath: MODEL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.55,
      minTrackingConfidence: 0.55,
    };
    try {
      landmarker = await mod.HandLandmarker.createFromOptions(vision, options);
    } catch {
      // GPU delegate is not available on every driver/VM; CPU still tracks fine.
      landmarker = await mod.HandLandmarker.createFromOptions(vision, {
        ...options,
        baseOptions: { modelAssetPath: MODEL, delegate: 'CPU' },
      });
    }
  } catch {
    cleanupStream();
    throw new Error('Hand model unavailable — check your connection');
  }

  onStatus('Show your palm to the camera');
  let lastVideoTime = -1;
  let lastDetect = 0;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    try { landmarker?.close?.(); } catch { /* already closed */ }
    cleanupStream();
    try { video.srcObject = null; } catch { /* detached */ }
  };

  const tick = () => {
    if (stopped) return;
    raf = requestAnimationFrame(tick);
    if (video.readyState < 2 || !video.videoWidth) return;

    const now = performance.now();
    if (now - lastDetect < 32) return;
    lastDetect = now;
    if (video.currentTime === lastVideoTime) return;
    lastVideoTime = video.currentTime;

    let result: any;
    try {
      result = landmarker.detectForVideo(video, now);
    } catch {
      return;
    }
    const landmarks = result?.landmarks?.[0] as HandPoint[] | undefined;
    if (!landmarks?.length) {
      onFrame({ gesture: 'none', palm: { x: 0.5, y: 0.5 }, pinch: 1, landmarks: [] });
      return;
    }
    const { gesture, palm, pinch } = classifyHand(landmarks);
    onFrame({ gesture, palm, pinch, landmarks });
  };

  raf = requestAnimationFrame(tick);
  return { stop };
}
