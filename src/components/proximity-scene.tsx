import { useEffect, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, {
  Circle,
  Defs,
  Ellipse,
  LinearGradient,
  Path,
  Polygon,
  Rect,
  Stop,
} from 'react-native-svg';

import { Status } from '@/constants/theme';
import { isLargeVehicle } from '@/device/geometry';
import { TrackSmoother, type SceneObject } from '@/device/tracks';
import type { Detection } from '@/device/types';
import { toPose, type Ground, type GroundBuilding, type GroundLine, type Pose } from '@/nav/ground';
import type { LatLon } from '@/nav/types';

/**
 * 3D view of what's around the bike: the bike at the centre, seen from behind
 * and above, with simple shapes for the vehicles and people the cameras see.
 *
 * This is a small hand-rolled perspective renderer drawn as vector shapes, not
 * a 3D engine: a GPU-based one (expo-gl + three.js) hung the app in Expo Go.
 * World frame matches device/geometry.ts: +x right, -z ahead, metres.
 * Positions are estimates.
 */

type Props = {
  detections: Detection[];
  speedKmh: number | null;
  /** Real streets and the route. With `at`, the ground shows the map instead of a plain road. */
  ground?: Ground | null;
  /** Where the bike is and which way it is heading (degrees clockwise from north). */
  at?: (LatLon & { heading: number }) | null;
};

const GROUND = '#ECEBE6';
const LINE = '#C4C3BC';

// ---- Camera -------------------------------------------------------------------
const EYE = [0, 7.5, 13] as const;
const TARGET = [0, 0.5, -4] as const;
/** Focal length as a multiple of the view's width (about a 40° horizontal field of view). */
const FOCAL_PER_WIDTH = 1.35;
const NEAR = 1.5;
const FOG_START = 24;
const FOG_END = 60;

type Vec = readonly [number, number, number];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec): Vec => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalize = (a: Vec): Vec => {
  const length = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / length, a[1] / length, a[2] / length];
};

const FORWARD = normalize(sub(TARGET, EYE));
const RIGHT = normalize(cross(FORWARD, [0, 1, 0]));
const UP = cross(RIGHT, FORWARD);

type Point = { x: number; y: number; depth: number };
type Projector = (x: number, y: number, z: number) => Point;

function makeProjector(width: number, height: number): Projector {
  // Scale from the width, so shapes stay the same size however tall the view is.
  const focal = width * FOCAL_PER_WIDTH;
  return (x, y, z) => {
    const d = sub([x, y, z], EYE);
    const depth = Math.max(dot(d, FORWARD), 0.01);
    return {
      x: width / 2 + (dot(d, RIGHT) / depth) * focal,
      // Drawn a little below centre so the far end of the road clears the speed readout.
      y: height * 0.58 - (dot(d, UP) / depth) * focal,
      depth,
    };
  };
}

/** 1 near the camera, fading to 0 in the distance. */
function fog(depth: number) {
  return 1 - Math.min(Math.max((depth - FOG_START) / (FOG_END - FOG_START), 0), 1);
}

const points = (...ps: Point[]) => ps.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

// ---- Scene pieces ---------------------------------------------------------------

const PALETTE = {
  neutral: { top: '#8B919B', back: '#6C727D', side: '#575D67' },
  danger: { top: '#F27377', back: Status.danger, side: '#B3383C' },
};

/** A box standing on the road, drawn as the three faces the camera can see. */
function Box({
  project,
  x,
  z,
  width,
  length,
  bottom,
  top,
  colors,
  opacity,
}: {
  project: Projector;
  x: number;
  z: number;
  width: number;
  length: number;
  bottom: number;
  top: number;
  colors: { top: string; back: string; side: string };
  opacity: number;
}) {
  const x0 = x - width / 2;
  const x1 = x + width / 2;
  const zFar = z - length / 2;
  const zNear = z + length / 2;
  // The side that faces the middle of the road is the visible one.
  const sideX = x < 0 ? x1 : x0;

  return (
    <>
      <Polygon
        fill={colors.side}
        opacity={opacity}
        points={points(
          project(sideX, bottom, zFar),
          project(sideX, bottom, zNear),
          project(sideX, top, zNear),
          project(sideX, top, zFar),
        )}
      />
      <Polygon
        fill={colors.back}
        opacity={opacity}
        points={points(
          project(x0, bottom, zNear),
          project(x1, bottom, zNear),
          project(x1, top, zNear),
          project(x0, top, zNear),
        )}
      />
      <Polygon
        fill={colors.top}
        opacity={opacity}
        points={points(
          project(x0, top, zFar),
          project(x1, top, zFar),
          project(x1, top, zNear),
          project(x0, top, zNear),
        )}
      />
    </>
  );
}

/** An upright figure: a rounded body with a head, always facing the camera. */
function Figure({
  project,
  x,
  z,
  color,
  opacity,
}: {
  project: Projector;
  x: number;
  z: number;
  color: string;
  opacity: number;
}) {
  const foot = project(x, 0, z);
  const shoulder = project(x, 1.45, z);
  const head = project(x, 1.62, z);
  const scale = (foot.y - shoulder.y) / 1.45; // pixels per metre at this depth
  const bodyWidth = 0.5 * scale;
  return (
    <>
      <Rect
        x={foot.x - bodyWidth / 2}
        y={shoulder.y}
        width={bodyWidth}
        height={foot.y - shoulder.y}
        rx={bodyWidth / 2}
        fill={color}
        opacity={opacity}
      />
      <Circle cx={head.x} cy={head.y} r={0.17 * scale} fill={color} opacity={opacity} />
    </>
  );
}

/** Another cyclist: a wheel seen edge-on with a rider above it, in their own colour. */
function Cyclist({
  project,
  x,
  z,
  opacity,
}: {
  project: Projector;
  x: number;
  z: number;
  opacity: number;
}) {
  const ground = project(x, 0, z);
  const saddle = project(x, 0.8, z);
  const scale = (ground.y - saddle.y) / 0.8;
  return (
    <>
      <Rect
        x={ground.x - 0.06 * scale}
        y={saddle.y}
        width={0.12 * scale}
        height={ground.y - saddle.y}
        rx={0.06 * scale}
        fill={Status.cyclist}
        opacity={opacity}
      />
      <Rect
        x={ground.x - 0.22 * scale}
        y={project(x, 1.5, z).y}
        width={0.44 * scale}
        height={0.8 * scale}
        rx={0.2 * scale}
        fill={Status.cyclist}
        opacity={opacity}
      />
      <Circle
        cx={ground.x}
        cy={project(x, 1.66, z).y}
        r={0.15 * scale}
        fill={Status.cyclist}
        opacity={opacity}
      />
    </>
  );
}

function SceneObjectShape({ object, project }: { object: SceneObject; project: Projector }) {
  const centre = project(object.x, 0.7, object.z);
  // Shapes right next to the camera look stretched, so they fade in as they move away from it.
  const nearFade = Math.min(Math.max((centre.depth - NEAR - 2.5) / 4, 0), 1);
  const opacity = object.alpha * fog(centre.depth) * nearFade;
  if (opacity <= 0.02) return null;

  if (object.label === 'bicycle') {
    return <Cyclist project={project} x={object.x} z={object.z} opacity={opacity} />;
  }
  if (object.label === 'person') {
    return <Figure project={project} x={object.x} z={object.z} color="#3F7FE0" opacity={opacity} />;
  }

  const colors = object.close ? PALETTE.danger : PALETTE.neutral;
  const shared = { project, x: object.x, colors, opacity };
  if (isLargeVehicle(object.label)) {
    return <Box {...shared} z={object.z} width={2.5} length={8} bottom={0.25} top={3.1} />;
  }
  return (
    <>
      <Box {...shared} z={object.z} width={1.8} length={4.3} bottom={0.15} top={0.85} />
      <Box {...shared} z={object.z + 0.15} width={1.5} length={2.2} bottom={0.85} top={1.4} />
    </>
  );
}

const DASH_SPACING = 6;
const DASH_LENGTH = 2.6;
const DASH_COUNT = 18;
/** Road markings start just in front of the camera and run to the fog. */
const ROAD_NEAR_Z = 10.5;

/** Where the plain road's surfaces end, in metres ahead; the haze hides the far edge. */
const ROAD_FAR_Z = -95;
/** Lane edges across the road, in metres from the rider (negative is left). */
const KERB_LEFT = -8;
const LANE_DIVIDER = -4.55;
const BIKE_LANE_LEFT = -1.1;
const BIKE_LANE_RIGHT = 1.1;
const PAVEMENT_RIGHT = 3.4;

/**
 * The road shown when no route is planned: two traffic lanes on the left, the
 * bike lane the rider is in, and a pavement on the right.
 */
function Road({
  project,
  dashOffset,
  width,
  haze = true,
}: {
  project: Projector;
  dashOffset: number;
  width: number;
  /** Off when something else is drawn on top and adds the haze itself */
  haze?: boolean;
}) {
  const band = (left: number, right: number, zFrom = ROAD_NEAR_Z, zTo = ROAD_FAR_Z) =>
    points(
      project(left, 0, zFrom),
      project(right, 0, zFrom),
      project(right, 0, zTo),
      project(left, 0, zTo),
    );
  const line = (x: number) => band(x - 0.06, x + 0.06);

  const dashes: ReactNode[] = [];
  // Dashed line between the traffic lanes, scrolling towards the viewer with the bike's speed
  for (let i = 0; i < DASH_COUNT; i++) {
    const from = Math.min(24 - i * DASH_SPACING + dashOffset, ROAD_NEAR_Z);
    const to = from - DASH_LENGTH;
    if (to > ROAD_NEAR_Z - 0.5) continue;
    dashes.push(
      <Polygon
        key={i}
        fill={LINE}
        points={band(LANE_DIVIDER - 0.07, LANE_DIVIDER + 0.07, from, to)}
      />,
    );
  }

  return (
    <>
      <Polygon fill={STREET.major.color} points={band(KERB_LEFT, BIKE_LANE_LEFT)} />
      <Polygon fill={STREET.cycle.color} points={band(BIKE_LANE_LEFT, BIKE_LANE_RIGHT)} />
      <Polygon fill={STREET.foot.color} points={band(BIKE_LANE_RIGHT, PAVEMENT_RIGHT)} />
      <Polygon fill={LINE} points={line(KERB_LEFT)} />
      <Polygon fill="#FFFFFF" points={line(BIKE_LANE_LEFT)} />
      <Polygon fill={LINE} points={line(BIKE_LANE_RIGHT)} />
      {dashes}
      {haze && <Haze project={project} width={width} />}
    </>
  );
}

// ---- The map on the ground --------------------------------------------------------

/** How far the ground is drawn: ahead, to each side, and towards the camera. */
const GROUND_AHEAD_M = 95;
const GROUND_SIDE_M = 70;
const GROUND_BEHIND_M = 10;
const GROUND_REACH_M = 120;

/** Half-widths in metres, and colours, for each kind of street. */
const STREET = {
  minor: { half: 3, color: '#FAFAF8' },
  foot: { half: 2, color: '#F5F4F0' },
  major: { half: 4.6, color: '#FFFFFF' },
  cycle: { half: 1.3, color: '#CDEBDC' },
} as const;
const ROUTE_HALF_M = 0.45;
const ROUTE_LANE_HALF_M = 1.2;
const ROUTE_BED_HALF_M = 3;

/**
 * Builds one SVG path holding every visible stretch of the given lines, as
 * flat ribbons on the road surface seen in perspective.
 */
function ribbons(lines: GroundLine[], pose: Pose, half: number, project: Projector) {
  const sin = Math.sin((pose.heading * Math.PI) / 180);
  const cos = Math.cos((pose.heading * Math.PI) / 180);
  let d = '';

  for (const line of lines) {
    if (
      line.maxE < pose.east - GROUND_REACH_M ||
      line.minE > pose.east + GROUND_REACH_M ||
      line.maxN < pose.north - GROUND_REACH_M ||
      line.minN > pose.north + GROUND_REACH_M
    ) {
      continue;
    }
    let prevX = 0;
    let prevZ = 0;
    for (let i = 0; i < line.east.length; i++) {
      // Map metres -> the scene's frame: x to the rider's right, -z straight ahead.
      const de = line.east[i] - pose.east;
      const dn = line.north[i] - pose.north;
      const x = de * cos - dn * sin;
      const z = -(de * sin + dn * cos);
      if (i > 0) d += ribbon(prevX, prevZ, x, z, half, project);
      d += joint(x, z, half, project);
      prevX = x;
      prevZ = z;
    }
  }
  return d;
}

function ribbon(x0: number, z0: number, x1: number, z1: number, half: number, project: Projector) {
  // Entirely out of view?
  if (
    (z0 > GROUND_BEHIND_M && z1 > GROUND_BEHIND_M) ||
    (z0 < -GROUND_AHEAD_M && z1 < -GROUND_AHEAD_M)
  ) {
    return '';
  }
  if ((x0 > GROUND_SIDE_M && x1 > GROUND_SIDE_M) || (x0 < -GROUND_SIDE_M && x1 < -GROUND_SIDE_M)) {
    return '';
  }
  // Trim the part that runs behind the camera or off into the distance.
  if (z0 > GROUND_BEHIND_M) {
    x0 += ((GROUND_BEHIND_M - z0) / (z1 - z0)) * (x1 - x0);
    z0 = GROUND_BEHIND_M;
  } else if (z1 > GROUND_BEHIND_M) {
    x1 += ((GROUND_BEHIND_M - z1) / (z0 - z1)) * (x0 - x1);
    z1 = GROUND_BEHIND_M;
  }
  if (z0 < -GROUND_AHEAD_M) {
    x0 += ((-GROUND_AHEAD_M - z0) / (z1 - z0)) * (x1 - x0);
    z0 = -GROUND_AHEAD_M;
  } else if (z1 < -GROUND_AHEAD_M) {
    x1 += ((-GROUND_AHEAD_M - z1) / (z0 - z1)) * (x0 - x1);
    z1 = -GROUND_AHEAD_M;
  }

  const dx = x1 - x0;
  const dz = z1 - z0;
  const length = Math.hypot(dx, dz);
  if (length < 0.05) return '';
  const ux = dx / length;
  const uz = dz / length;
  const ax = x0;
  const az = z0;
  const bx = x1;
  const bz = z1;
  const nx = -uz * half;
  const nz = ux * half;

  const p1 = project(ax + nx, 0, az + nz);
  const p2 = project(bx + nx, 0, bz + nz);
  const p3 = project(bx - nx, 0, bz - nz);
  const p4 = project(ax - nx, 0, az - nz);
  return `M${p1.x.toFixed(1)} ${p1.y.toFixed(1)}L${p2.x.toFixed(1)} ${p2.y.toFixed(1)}L${p3.x.toFixed(1)} ${p3.y.toFixed(1)}L${p4.x.toFixed(1)} ${p4.y.toFixed(1)}Z`;
}

const JOINT_SIDES = 8;
const JOINT_COS = Array.from({ length: JOINT_SIDES }, (_, i) =>
  Math.cos((i / JOINT_SIDES) * Math.PI * 2),
);
const JOINT_SIN = Array.from({ length: JOINT_SIDES }, (_, i) =>
  Math.sin((i / JOINT_SIDES) * Math.PI * 2),
);

/** A round patch where two stretches meet, so bends have no notches or spikes. */
function joint(x: number, z: number, half: number, project: Projector) {
  if (z > GROUND_BEHIND_M || z < -GROUND_AHEAD_M || x > GROUND_SIDE_M || x < -GROUND_SIDE_M) {
    return '';
  }
  let d = '';
  // Same turning direction as the ribbons, so overlapping shapes never cancel out.
  for (let i = JOINT_SIDES - 1; i >= 0; i--) {
    const p = project(x + JOINT_COS[i] * half, 0, z + JOINT_SIN[i] * half);
    d += `${i === JOINT_SIDES - 1 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  }
  return `${d}Z`;
}

// ---- Buildings ---------------------------------------------------------------------

/** Buildings are drawn in full out to here, then fade out by BUILDING_FAR_M. */
const BUILDING_CLEAR_M = 55;
const BUILDING_FAR_M = 95;
/** Nothing is drawn nearer the camera than this (z, metres). */
const BUILDING_NEAR_Z = 8;
/** Real heights would tower over the view and hide the road, so they are capped. */
const BUILDING_MAX_HEIGHT_M = 16;
const BUILDING_MIN_HEIGHT_M = 4;
/** Far-to-near groups. Each is two shapes, so nearer buildings cover further ones. */
const BUILDING_BANDS = 6;
const WALL = '#CFCEC7';
const ROOF = '#DDDCD5';
const ROOF_EDGE = '#B9B8B0';

/** One closed shape, always wound the same way on screen so overlapping ones never cancel. */
function closed(xs: number[], ys: number[]) {
  let area = 0;
  for (let i = 0; i < xs.length; i++) {
    const j = (i + 1) % xs.length;
    area += xs[i] * ys[j] - xs[j] * ys[i];
  }
  let d = '';
  for (let k = 0; k < xs.length; k++) {
    const i = area >= 0 ? k : xs.length - 1 - k;
    d += `${k === 0 ? 'M' : 'L'}${xs[i].toFixed(1)} ${ys[i].toFixed(1)}`;
  }
  return `${d}Z`;
}

/** Building outlines pushed up into blocks: dark walls with a lighter roof. */
function Buildings({
  buildings,
  pose,
  project,
}: {
  buildings: GroundBuilding[];
  pose: Pose;
  project: Projector;
}) {
  const sin = Math.sin((pose.heading * Math.PI) / 180);
  const cos = Math.cos((pose.heading * Math.PI) / 180);

  const visible: { z: number; fade: number; walls: string; roof: string }[] = [];
  for (const b of buildings) {
    const distance = Math.hypot(b.centreE - pose.east, b.centreN - pose.north);
    if (distance > BUILDING_FAR_M) continue;

    const count = b.east.length;
    const baseX: number[] = [];
    const baseY: number[] = [];
    const topX: number[] = [];
    const topY: number[] = [];
    const height = Math.min(Math.max(b.height, BUILDING_MIN_HEIGHT_M), BUILDING_MAX_HEIGHT_M);
    // Stays true only if every corner is level with the camera or behind it.
    let tooNear = true;
    for (let i = 0; i < count; i++) {
      const de = b.east[i] - pose.east;
      const dn = b.north[i] - pose.north;
      const x = de * cos - dn * sin;
      const z = -(de * sin + dn * cos);
      if (z < BUILDING_NEAR_Z) tooNear = false;
      // The part of a building that runs back past the camera is cut off flat.
      const cut = Math.min(z, BUILDING_NEAR_Z);
      const base = project(x, 0, cut);
      const top = project(x, height, cut);
      baseX.push(base.x);
      baseY.push(base.y);
      topX.push(top.x);
      topY.push(top.y);
    }
    if (tooNear) continue;

    let walls = '';
    for (let i = 0; i < count; i++) {
      const j = (i + 1) % count;
      walls += closed(
        [baseX[i], baseX[j], topX[j], topX[i]],
        [baseY[i], baseY[j], topY[j], topY[i]],
      );
    }
    const de = b.centreE - pose.east;
    const dn = b.centreN - pose.north;
    visible.push({
      z: -(de * sin + dn * cos),
      fade:
        1 -
        Math.min(
          Math.max((distance - BUILDING_CLEAR_M) / (BUILDING_FAR_M - BUILDING_CLEAR_M), 0),
          1,
        ),
      walls,
      roof: closed(topX, topY),
    });
  }
  if (visible.length === 0) return null;

  visible.sort((a, b) => a.z - b.z); // furthest ahead first
  const perBand = Math.ceil(visible.length / BUILDING_BANDS);
  const bands: ReactNode[] = [];
  for (let start = 0; start < visible.length; start += perBand) {
    const group = visible.slice(start, start + perBand);
    const opacity = group.reduce((sum, v) => sum + v.fade, 0) / group.length;
    if (opacity <= 0.03) continue;
    bands.push(
      <Path
        key={`w${start}`}
        d={group.map((v) => v.walls).join('')}
        fill={WALL}
        opacity={opacity}
      />,
      <Path
        key={`r${start}`}
        d={group.map((v) => v.roof).join('')}
        fill={ROOF}
        stroke={ROOF_EDGE}
        strokeWidth={0.75}
        opacity={opacity}
      />,
    );
  }
  return <>{bands}</>;
}

/** Distance haze: the ground fades out towards the horizon. */
function Haze({ project, width }: { project: Projector; width: number }) {
  // Fully hazed beyond about 80 m, clear from about 35 m in.
  const horizon = project(0, 0, -80).y;
  const clear = project(0, 0, -35).y;
  return (
    <>
      <Defs>
        <LinearGradient
          id="haze"
          x1="0"
          y1={horizon}
          x2="0"
          y2={clear}
          gradientUnits="userSpaceOnUse"
        >
          <Stop offset="0" stopColor={GROUND} stopOpacity="1" />
          <Stop offset="1" stopColor={GROUND} stopOpacity="0" />
        </LinearGradient>
      </Defs>
      <Rect x={0} y={0} width={width} height={horizon + 1} fill={GROUND} />
      <Rect x={0} y={horizon} width={width} height={clear - horizon} fill="url(#haze)" />
    </>
  );
}

/** A road counts as under the rider if its centre line passes within this many metres. */
const UNDER_RIDER_M = 9;

/** Whether the route or any loaded street runs under the rider. */
function hasRoadUnder(ground: Ground, pose: Pose) {
  const near = (line: GroundLine) => {
    if (
      line.maxE < pose.east - UNDER_RIDER_M ||
      line.minE > pose.east + UNDER_RIDER_M ||
      line.maxN < pose.north - UNDER_RIDER_M ||
      line.minN > pose.north + UNDER_RIDER_M
    ) {
      return false;
    }
    for (let i = 0; i < line.east.length - 1; i++) {
      // Distance from the rider to this stretch of the line.
      const ax = line.east[i] - pose.east;
      const ay = line.north[i] - pose.north;
      const dx = line.east[i + 1] - line.east[i];
      const dy = line.north[i + 1] - line.north[i];
      const lengthSq = dx * dx + dy * dy;
      const t = lengthSq === 0 ? 0 : Math.min(Math.max(-(ax * dx + ay * dy) / lengthSq, 0), 1);
      if (Math.hypot(ax + t * dx, ay + t * dy) < UNDER_RIDER_M) return true;
    }
    return false;
  };
  if (near(ground.routeBed)) return true;
  const { minor, major, cycle, foot } = ground.roads;
  return minor.some(near) || major.some(near) || cycle.some(near) || foot.some(near);
}

function MapGround({
  ground,
  pose,
  project,
  width,
  dashOffset,
}: {
  ground: Ground;
  pose: Pose;
  project: Projector;
  width: number;
  dashOffset: number;
}) {
  const minor = ribbons(ground.roads.minor, pose, STREET.minor.half, project);
  const foot = ribbons(ground.roads.foot, pose, STREET.foot.half, project);
  const major = ribbons(ground.roads.major, pose, STREET.major.half, project);
  const cycle = ribbons(ground.roads.cycle, pose, STREET.cycle.half, project);
  const bed = ribbons([ground.routeBed], pose, ROUTE_BED_HALF_M, project);

  // Off the route with no street under the rider: put the plain road beneath, so the rider is
  // never floating on empty ground.
  const stranded = !hasRoadUnder(ground, pose);

  return (
    <>
      {stranded && <Road project={project} dashOffset={dashOffset} width={width} haze={false} />}
      <Path d={minor} fill={STREET.minor.color} />
      <Path d={foot} fill={STREET.foot.color} />
      <Path d={major} fill={STREET.major.color} />
      <Path d={cycle} fill={STREET.cycle.color} />
      {/* A lane under the route itself, so there is always road beneath the rider: before the
          streets have loaded, and on paths the map data has nothing for. */}
      <Path d={bed} fill={STREET.major.color} />
      <Path
        d={ribbons([ground.routeBed], pose, ROUTE_LANE_HALF_M, project)}
        fill={STREET.cycle.color}
      />
      <Path
        d={ribbons([ground.route], pose, ROUTE_HALF_M, project)}
        fill={Status.accent}
        opacity={0.9}
      />
      <Haze project={project} width={width} />
    </>
  );
}

/** The rider is black so they stand out from the blue route underneath. */
const RIDER = '#111111';

function Bike({ project }: { project: Projector }) {
  const centre = project(0, 0, 0);
  const edgeX = project(1.25, 0, 0);
  const edgeZ = project(0, 0, 1.25);
  const ground = project(0, 0, 0.3);
  const saddle = project(0, 0.8, 0.3);
  const scale = (ground.y - saddle.y) / 0.8;
  const bar = project(0, 1.0, -0.5);

  return (
    <>
      {/* Glow on the road under the bike */}
      <Ellipse
        cx={centre.x}
        cy={centre.y}
        rx={edgeX.x - centre.x}
        ry={edgeZ.y - centre.y}
        fill={Status.accent}
        opacity={0.16}
      />
      {/* Rear wheel, seen edge-on */}
      <Rect
        x={ground.x - 0.05 * scale}
        y={saddle.y}
        width={0.1 * scale}
        height={ground.y - saddle.y}
        rx={0.05 * scale}
        fill={RIDER}
      />
      {/* Handlebar */}
      <Rect
        x={bar.x - 0.3 * scale}
        y={bar.y - 0.035 * scale}
        width={0.6 * scale}
        height={0.07 * scale}
        rx={0.035 * scale}
        fill={RIDER}
      />
      {/* Rider */}
      <Rect
        x={saddle.x - 0.21 * scale}
        y={project(0, 1.5, 0.1).y}
        width={0.42 * scale}
        height={0.78 * scale}
        rx={0.2 * scale}
        fill={RIDER}
      />
      <Circle cx={saddle.x} cy={project(0, 1.66, -0.1).y} r={0.15 * scale} fill={RIDER} />
    </>
  );
}

// ---- Animation loop -------------------------------------------------------------

type Frame = { objects: SceneObject[]; dashOffset: number; pose: Pose | null };

/** Steps the scene on every display frame and returns what to draw. */
function useSceneFrame(props: Props): Frame {
  const [frame, setFrame] = useState<Frame>({
    objects: [],
    dashOffset: 0,
    pose: null,
  });
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });

  useEffect(() => {
    const smoother = new TrackSmoother();
    let dashOffset = 0;
    let last: number | null = null;
    let pose: Pose | null = null;
    let poseGround: Ground | null = null;
    let handle = requestAnimationFrame(function tick(timeMs) {
      const now = timeMs / 1000;
      const dt = last == null ? 0 : Math.min(now - last, 0.1);
      last = now;
      const { detections, speedKmh, ground, at } = latest.current;
      dashOffset = (dashOffset + ((speedKmh ?? 0) / 3.6) * dt) % DASH_SPACING;

      // Position fixes arrive in steps (once a second from GPS), so glide between them.
      if (ground && at) {
        const target = toPose(ground, at, at.heading);
        if (!pose || poseGround !== ground) {
          pose = target;
          poseGround = ground;
        } else {
          const ease = 1 - Math.exp(-dt * 5);
          const turn = ((target.heading - pose.heading + 540) % 360) - 180; // shortest way round
          pose = {
            east: pose.east + (target.east - pose.east) * ease,
            north: pose.north + (target.north - pose.north) * ease,
            heading: pose.heading + turn * (1 - Math.exp(-dt * 3.5)),
          };
        }
      } else {
        pose = null;
      }

      setFrame({
        objects: smoother.step(detections, now, dt),
        dashOffset,
        pose,
      });
      handle = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(handle);
  }, []);

  return frame;
}

export function ProximityScene(props: Props) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const frame = useSceneFrame(props);
  const project = makeProjector(size.width, size.height);

  // Painter's order: far things first, so nearer ones cover them. The bike sits at z = 0.
  const sorted = [...frame.objects].sort((a, b) => a.z - b.z);
  const aheadOfBike = sorted.filter((o) => o.z < 0);
  const behindTheBike = sorted.filter((o) => o.z >= 0);

  return (
    <View
      style={styles.container}
      onLayout={(e) => setSize(e.nativeEvent.layout)}
      accessibilityLabel="Estimated positions of nearby objects"
    >
      {size.width > 0 && (
        <Svg width={size.width} height={size.height}>
          {props.ground && frame.pose ? (
            <MapGround
              ground={props.ground}
              pose={frame.pose}
              project={project}
              width={size.width}
              dashOffset={frame.dashOffset}
            />
          ) : (
            <Road project={project} dashOffset={frame.dashOffset} width={size.width} />
          )}
          {props.ground && frame.pose && (
            <Buildings buildings={props.ground.buildings} pose={frame.pose} project={project} />
          )}
          {aheadOfBike.map((o) => (
            <SceneObjectShape key={o.id} object={o} project={project} />
          ))}
          <Bike project={project} />
          {behindTheBike.map((o) => (
            <SceneObjectShape key={o.id} object={o} project={project} />
          ))}
        </Svg>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: GROUND },
});
