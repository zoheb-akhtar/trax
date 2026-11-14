import { useEffect, useState } from 'react';
import { useReducedMotion } from 'react-native-reanimated';
import Svg, { Defs, Ellipse, Path, RadialGradient, Stop } from 'react-native-svg';

/**
 * A glowing green wireframe bike that slowly turns, shown on the Ride tab while Velo is armed.
 *
 * Like the ride view, this is a small hand-rolled 3D drawing in vector shapes,
 * not a 3D engine: the bike is a set of line segments in metres, turned about
 * the vertical axis and projected in perspective on every frame.
 */

type P = readonly [number, number, number]; // x (along the bike), y (up), z (across)
type Segment = readonly [P, P];

const GLOW = '#1DB870';
const CORE = '#0C8A4E';

const WHEEL_R = 0.34;
const REAR: P = [-0.52, WHEEL_R, 0];
const FRONT: P = [0.52, WHEEL_R, 0];
const CRANK: P = [-0.1, 0.3, 0];
const SEAT: P = [-0.24, 0.84, 0];
const HEAD: P = [0.3, 0.88, 0];
const HEAD_LOW: P = [0.35, 0.7, 0];
const BAR: P = [0.33, 0.97, 0];

function circle(centre: P, radius: number, steps: number): Segment[] {
  const out: Segment[] = [];
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const b = ((i + 1) / steps) * Math.PI * 2;
    out.push([
      [centre[0] + Math.cos(a) * radius, centre[1] + Math.sin(a) * radius, centre[2]],
      [centre[0] + Math.cos(b) * radius, centre[1] + Math.sin(b) * radius, centre[2]],
    ]);
  }
  return out;
}

function spokes(centre: P, radius: number, count: number): Segment[] {
  return Array.from({ length: count }, (_, i): Segment => {
    const a = (i / count) * Math.PI * 2;
    return [centre, [centre[0] + Math.cos(a) * radius, centre[1] + Math.sin(a) * radius, 0]];
  });
}

/** Tubes and wheels: drawn bright. */
const FRAME: Segment[] = [
  ...circle(REAR, WHEEL_R, 28),
  ...circle(FRONT, WHEEL_R, 28),
  [CRANK, SEAT], // seat tube
  [SEAT, HEAD], // top tube
  [CRANK, HEAD_LOW], // down tube
  [HEAD, HEAD_LOW], // head tube
  [REAR, CRANK], // chain stay
  [REAR, SEAT], // seat stay
  [HEAD_LOW, FRONT], // fork
  [HEAD, BAR], // stem
  [
    [BAR[0], BAR[1], -0.21],
    [BAR[0], BAR[1], 0.21],
  ], // handlebar
  [SEAT, [-0.26, 0.93, 0]], // seat post
  [
    [-0.36, 0.94, 0],
    [-0.16, 0.93, 0.05],
  ],
  [
    [-0.36, 0.94, 0],
    [-0.16, 0.93, -0.05],
  ],
  [
    [-0.16, 0.93, 0.05],
    [-0.16, 0.93, -0.05],
  ], // saddle
  [
    [CRANK[0], CRANK[1], 0.07],
    [CRANK[0] + 0.12, CRANK[1] - 0.11, 0.07],
  ],
  [
    [CRANK[0], CRANK[1], -0.07],
    [CRANK[0] - 0.12, CRANK[1] + 0.11, -0.07],
  ], // cranks
  [
    [CRANK[0] + 0.12, CRANK[1] - 0.11, 0.07],
    [CRANK[0] + 0.12, CRANK[1] - 0.11, 0.15],
  ],
  [
    [CRANK[0] - 0.12, CRANK[1] + 0.11, -0.07],
    [CRANK[0] - 0.12, CRANK[1] + 0.11, -0.15],
  ], // pedals
];

/** Spokes: drawn faint, so the wheels read as wheels without becoming a blur. */
const DETAIL: Segment[] = [...spokes(REAR, WHEEL_R, 8), ...spokes(FRONT, WHEEL_R, 8)];

/** Size of one metre as a share of the canvas; small enough that the bike fits side-on. */
const MODEL_SCALE = 0.52;
const TILT = (14 * Math.PI) / 180; // looking slightly down on the bike
const COS_TILT = Math.cos(TILT);
const SIN_TILT = Math.sin(TILT);
const EYE_DISTANCE = 4.2;
const CENTRE_Y = 0.48;
/** Radians per second: a slow drift, one turn in about 25 seconds. */
const SPIN = 0.25;
/** The three-quarter view shown when the phone is set to reduce motion. */
const STILL_ANGLE = -0.6;

function path(segments: Segment[], angle: number, size: number) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const scale = size * MODEL_SCALE;
  const point = ([x, y, z]: P) => {
    const rx = x * cos + z * sin;
    const rz = -x * sin + z * cos;
    const ry = (y - CENTRE_Y) * COS_TILT - rz * SIN_TILT;
    const depth = (y - CENTRE_Y) * SIN_TILT + rz * COS_TILT;
    const k = (EYE_DISTANCE / (EYE_DISTANCE + depth)) * scale;
    return `${(size / 2 + rx * k).toFixed(1)} ${(size * 0.5 - ry * k).toFixed(1)}`;
  };
  let d = '';
  for (const [a, b] of segments) d += `M${point(a)}L${point(b)}`;
  return d;
}

export function ArmedBike({ size }: { size: number }) {
  const reduceMotion = useReducedMotion();
  const [angle, setAngle] = useState(STILL_ANGLE);

  useEffect(() => {
    if (reduceMotion) return;
    let last: number | null = null;
    let handle = requestAnimationFrame(function tick(timeMs) {
      const dt = last == null ? 0 : Math.min((timeMs - last) / 1000, 0.1);
      last = timeMs;
      setAngle((a) => a + SPIN * dt);
      handle = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(handle);
  }, [reduceMotion]);

  const shown = reduceMotion ? STILL_ANGLE : angle;
  const frame = path(FRAME, shown, size);
  const detail = path(DETAIL, shown, size);
  const floorY = size * 0.5 + CENTRE_Y * COS_TILT * size * MODEL_SCALE;

  return (
    <Svg width={size} height={size} accessibilityLabel="Bike secured">
      <Defs>
        <RadialGradient
          id="floor"
          cx={size / 2}
          cy={floorY}
          rx={size * 0.4}
          ry={size * 0.1}
          fx={size / 2}
          fy={floorY}
          gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor={GLOW} stopOpacity="0.3" />
          <Stop offset="1" stopColor={GLOW} stopOpacity="0" />
        </RadialGradient>
      </Defs>

      {/* Pool of light on the ground, and a ring around it */}
      <Ellipse cx={size / 2} cy={floorY} rx={size * 0.4} ry={size * 0.1} fill="url(#floor)" />
      <Ellipse
        cx={size / 2}
        cy={floorY}
        rx={size * 0.43}
        ry={size * 0.108}
        fill="none"
        stroke={GLOW}
        strokeOpacity={0.35}
        strokeWidth={1}
      />

      <Path d={detail} stroke={GLOW} strokeOpacity={0.3} strokeWidth={0.8} fill="none" />
      {/* The same lines three times, wide and faint to narrow and bright: that is the glow. */}
      <Path
        d={frame}
        stroke={GLOW}
        strokeOpacity={0.12}
        strokeWidth={9}
        strokeLinecap="round"
        fill="none"
      />
      <Path
        d={frame}
        stroke={GLOW}
        strokeOpacity={0.3}
        strokeWidth={4.5}
        strokeLinecap="round"
        fill="none"
      />
      <Path d={frame} stroke={CORE} strokeWidth={1.7} strokeLinecap="round" fill="none" />
    </Svg>
  );
}
