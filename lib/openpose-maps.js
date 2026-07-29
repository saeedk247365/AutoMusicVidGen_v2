import { encodeRgbPng } from "./png.js";

const W = 512;
const H = 768;

/** OpenPose-ish limb colors on black. */
const C = {
  nose: [255, 0, 0],
  neck: [255, 85, 0],
  rShoulder: [255, 170, 0],
  rElbow: [255, 255, 0],
  rWrist: [170, 255, 0],
  lShoulder: [85, 255, 0],
  lElbow: [0, 255, 0],
  lWrist: [0, 255, 85],
  rHip: [0, 255, 170],
  rKnee: [0, 255, 255],
  rAnkle: [0, 170, 255],
  lHip: [0, 85, 255],
  lKnee: [0, 0, 255],
  lAnkle: [85, 0, 255],
  face: [255, 0, 85],
};

const BONE_COLORS = [
  ["nose", "neck", C.nose],
  ["neck", "rShoulder", C.rShoulder],
  ["neck", "lShoulder", C.lShoulder],
  ["rShoulder", "rElbow", C.rElbow],
  ["rElbow", "rWrist", C.rWrist],
  ["lShoulder", "lElbow", C.lElbow],
  ["lElbow", "lWrist", C.lWrist],
  ["neck", "rHip", C.rHip],
  ["neck", "lHip", C.lHip],
  ["rHip", "rKnee", C.rKnee],
  ["rKnee", "rAnkle", C.rAnkle],
  ["lHip", "lKnee", C.lKnee],
  ["lKnee", "lAnkle", C.lAnkle],
];

/** Camera yaw in degrees (body turns left/right relative to camera). */
export const ANGLE_YAW = {
  front: 0,
  threequarter_left: -55,
  threequarter_right: 55,
  side_left: -90,
  side_right: 90,
  threequarter_back_left: -145,
  threequarter_back_right: 145,
  back: 180,
};

function blank() {
  return Buffer.alloc(W * H * 3, 0);
}

function setPx(rgb, x, y, color) {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= W || yi >= H) return;
  const i = (yi * W + xi) * 3;
  rgb[i] = color[0];
  rgb[i + 1] = color[1];
  rgb[i + 2] = color[2];
}

function disc(rgb, x, y, r, color) {
  const rr = r * r;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= rr) setPx(rgb, x + dx, y + dy, color);
    }
  }
}

function line(rgb, x0, y0, x1, y1, color, thickness = 8) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    disc(rgb, x0 + dx * t, y0 + dy * t, thickness / 2, color);
  }
}

function bone(rgb, a, b, color) {
  if (!a || !b) return;
  line(rgb, a[0], a[1], b[0], b[1], color, 8);
  disc(rgb, a[0], a[1], 7, color);
  disc(rgb, b[0], b[1], 7, color);
}

/**
 * Canonical standing skeleton in body space (cm-ish).
 * +X = character's left, +Y = up, +Z = toward camera when yaw=0.
 */
function baseStand3d() {
  return {
    nose: [0, 165, 18],
    neck: [0, 145, 0],
    rShoulder: [-18, 140, 0],
    lShoulder: [18, 140, 0],
    rElbow: [-22, 110, 4],
    lElbow: [22, 110, 4],
    rWrist: [-24, 80, 2],
    lWrist: [24, 80, 2],
    rHip: [-9, 90, 0],
    lHip: [9, 90, 0],
    rKnee: [-10, 50, 2],
    lKnee: [10, 50, 2],
    rAnkle: [-11, 8, 0],
    lAnkle: [11, 8, 0],
  };
}

function clone3d(j) {
  const o = {};
  for (const [k, v] of Object.entries(j)) o[k] = [...v];
  return o;
}

const POSES = {
  stand(j) {
    return j;
  },
  wave(j) {
    const p = clone3d(j);
    p.rElbow = [-20, 155, 6];
    p.rWrist = [-14, 185, 10];
    return p;
  },
  hand_on_hip(j) {
    const p = clone3d(j);
    p.lElbow = [28, 115, 8];
    p.lWrist = [16, 95, 12];
    return p;
  },
  walk(j) {
    const p = clone3d(j);
    // Mild stride — extreme Z separation caused ghost/double legs under img2img+OpenPose
    p.lKnee = [10, 54, 10];
    p.lAnkle = [11, 9, 16];
    p.rKnee = [-10, 52, -6];
    p.rAnkle = [-11, 8, -10];
    p.rElbow = [-24, 108, -4];
    p.rWrist = [-22, 80, -8];
    p.lElbow = [24, 110, 6];
    p.lWrist = [26, 82, 10];
    return p;
  },
  sit(j) {
    const p = clone3d(j);
    p.rHip = [-10, 70, 0];
    p.lHip = [10, 70, 0];
    p.rKnee = [-12, 55, 22];
    p.lKnee = [12, 55, 22];
    p.rAnkle = [-12, 50, 42];
    p.lAnkle = [12, 50, 42];
    p.rElbow = [-18, 95, 8];
    p.lElbow = [18, 95, 8];
    p.rWrist = [-12, 72, 14];
    p.lWrist = [12, 72, 14];
    // Drop torso slightly
    for (const k of ["nose", "neck", "rShoulder", "lShoulder"]) p[k][1] -= 12;
    return p;
  },
  point(j) {
    const p = clone3d(j);
    p.rElbow = [-28, 130, 10];
    p.rWrist = [-40, 125, 28];
    return p;
  },
  hands_up(j) {
    const p = clone3d(j);
    p.rElbow = [-22, 165, 8];
    p.rWrist = [-16, 200, 12];
    p.lElbow = [22, 165, 8];
    p.lWrist = [16, 200, 12];
    return p;
  },
  crawl(j) {
    // Approximate toddler crawl / all-fours (OpenPose still uses standing skeleton layout)
    const p = clone3d(j);
    for (const k of ["nose", "neck", "rShoulder", "lShoulder", "rElbow", "lElbow", "rWrist", "lWrist"]) {
      p[k][1] -= 55;
      p[k][2] += 18;
    }
    p.rHip = [-12, 55, 8];
    p.lHip = [12, 55, 8];
    p.rKnee = [-18, 35, 28];
    p.lKnee = [18, 35, 28];
    p.rAnkle = [-20, 12, 40];
    p.lAnkle = [20, 12, 40];
    p.rElbow = [-28, 70, 30];
    p.lElbow = [28, 70, 30];
    p.rWrist = [-32, 45, 42];
    p.lWrist = [32, 45, 42];
    return p;
  },
  bust(j) {
    const p = clone3d(j);
    // Legs far below so ControlNet focuses on upper body
    p.rHip = [-9, 40, 0];
    p.lHip = [9, 40, 0];
    p.rKnee = [-10, -40, 0];
    p.lKnee = [10, -40, 0];
    p.rAnkle = [-11, -80, 0];
    p.lAnkle = [11, -80, 0];
    return p;
  },
};

function rotateY(point, deg) {
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const [x, y, z] = point;
  return [x * c + z * s, y, -x * s + z * c];
}

/**
 * Project body-space joints → image pixels.
 * Depth foreshortening on X; Y maps height.
 */
function project(joints3d, yawDeg, lookOverShoulder = false) {
  const rotated = {};
  for (const [k, p] of Object.entries(joints3d)) {
    rotated[k] = rotateY(p, yawDeg);
  }

  // Looking over shoulder only when requested
  if (lookOverShoulder && Math.abs(yawDeg) > 100) {
    const nose = rotated.nose;
    rotated.nose = [nose[0] * 0.35, nose[1], Math.max(nose[2], 14)];
  }

  const scale = 3.35;
  const cx = W / 2;
  const groundY = H - 40;
  const out = {};
  const depthSorted = Object.entries(rotated).sort((a, b) => a[1][2] - b[1][2]);

  for (const [k, [x, y, z]] of depthSorted) {
    const foreshorten = 1 + z * 0.004;
    const px = cx + x * scale * foreshorten;
    const py = groundY - y * scale;
    out[k] = [px, py, z];
  }
  return out;
}

function drawSkeleton(rgb, joints2d, yawDeg = 0) {
  // Draw far bones first
  const bones = BONE_COLORS.map(([a, b, color]) => {
    const ja = joints2d[a];
    const jb = joints2d[b];
    const z = ((ja?.[2] ?? 0) + (jb?.[2] ?? 0)) / 2;
    return { a: ja, b: jb, color, z };
  }).sort((u, v) => u.z - v.z);

  for (const { a, b, color } of bones) {
    bone(rgb, a, b, color);
  }

  // Face keypoints locked to body yaw (never twisted toward camera).
  // Profile: only near-side ear/eye so ControlNet does not invent a front-facing head.
  const nose = joints2d.nose;
  const neck = joints2d.neck;
  if (nose && neck) {
    const dx = nose[0] - neck[0];
    const dy = nose[1] - neck[1];
    const px = -dy * 0.35;
    const py = dx * 0.35;
    const leftEye = [nose[0] + px * 0.6 - dx * 0.15, nose[1] + py * 0.6 - dy * 0.15];
    const rightEye = [nose[0] - px * 0.6 - dx * 0.15, nose[1] - py * 0.6 - dy * 0.15];
    const leftEar = [nose[0] + px * 1.4 - dx * 0.55, nose[1] + py * 1.4 - dy * 0.55];
    const rightEar = [nose[0] - px * 1.4 - dx * 0.55, nose[1] - py * 1.4 - dy * 0.55];

    const absYaw = Math.abs(yawDeg % 360);
    const yawNorm = absYaw > 180 ? 360 - absYaw : absYaw;
    const profileLeft = yawNorm > 70 && yawDeg < 0; // body facing viewer's left
    const profileRight = yawNorm > 70 && yawDeg > 0;
    const rearish = yawNorm > 120;

    if (rearish && !joints2d._lookOver) {
      // Back of head toward camera — minimal face cue (no front-face invitation)
      disc(rgb, nose[0], nose[1], 6, C.face);
    } else if (profileLeft) {
      disc(rgb, leftEye[0], leftEye[1], 4, C.face);
      disc(rgb, leftEar[0], leftEar[1], 5, C.face);
      bone(rgb, leftEar, leftEye, C.face);
      bone(rgb, leftEye, nose, C.face);
      disc(rgb, nose[0], nose[1], 9, C.face);
    } else if (profileRight) {
      disc(rgb, rightEye[0], rightEye[1], 4, C.face);
      disc(rgb, rightEar[0], rightEar[1], 5, C.face);
      bone(rgb, rightEar, rightEye, C.face);
      bone(rgb, rightEye, nose, C.face);
      disc(rgb, nose[0], nose[1], 9, C.face);
    } else {
      disc(rgb, leftEye[0], leftEye[1], 4, C.face);
      disc(rgb, rightEye[0], rightEye[1], 4, C.face);
      disc(rgb, leftEar[0], leftEar[1], 5, C.face);
      disc(rgb, rightEar[0], rightEar[1], 5, C.face);
      bone(rgb, leftEar, leftEye, C.face);
      bone(rgb, rightEar, rightEye, C.face);
      bone(rgb, leftEye, nose, C.face);
      bone(rgb, rightEye, nose, C.face);
      disc(rgb, nose[0], nose[1], 10, C.face);
    }
  }
}

/**
 * @param {string} poseKey
 * @param {string} angleKey
 * @param {{ lookOverShoulder?: boolean, yaw?: number }} [opts]
 * @returns {Buffer}
 */
export function buildOpenPosePng(poseKey = "stand", angleKey = "front", opts = {}) {
  const rgb = blank();
  const base = baseStand3d();
  const poseFn = POSES[poseKey] || POSES.stand;
  const posed = poseFn(base);
  const yaw = opts.yaw ?? ANGLE_YAW[angleKey] ?? 0;
  const lookOver = Boolean(opts.lookOverShoulder);
  const joints2d = project(posed, yaw, lookOver);
  if (lookOver) joints2d._lookOver = true;
  drawSkeleton(rgb, joints2d, yaw);
  return encodeRgbPng(W, H, rgb);
}

export const POSE_KEYS = Object.keys(POSES);
export const ANGLE_KEYS = Object.keys(ANGLE_YAW);
