import type Anthropic from '@anthropic-ai/sdk';

import { isCloseVehicle, mergeCyclists, toWorld } from '@/device/geometry';
import type { CameraId, Connection, Detection, DeviceMode, DeviceState } from '@/device/types';
import { safetyScore, type Ride } from '@/history/ride-history';
import { searchPlaces } from '@/nav/api';
import { distance, formatDistance, formatDuration, formatSpeed } from '@/nav/geo';
import type { NavSnapshot, NavStore } from '@/nav/nav-store';
import type { LastSeen, Parked, SecurityEntry } from '@/security/security-log';

/** Everything the agent can read and do, supplied fresh for each tool call. */
export type AgentWorld = {
  device: {
    state: DeviceState;
    connection: Connection;
    setMode(mode: DeviceMode): void;
    silenceAlarm(): void;
    chirp(): void;
    snapshotUrlFor(camera: CameraId): string | null;
    /** Says a line out loud through the bike's own speaker */
    sayOnBike(text: string, urgent: boolean): Promise<boolean>;
    hasSpeaker: boolean;
  };
  trip: NavSnapshot;
  nav: NavStore;
  security: {
    entries: SecurityEntry[];
    parked: Parked | null;
    lastSeen: LastSeen | null;
    soundAlarm(): void;
  };
  rides: Ride[];
  ui: {
    setFullView(on: boolean): void;
    pinCamera(camera: CameraId | null): void;
    openScreen(screen: AppScreen): void;
  };
  /** Asks the owner in the app and resolves with their answer. */
  confirm(question: string): Promise<boolean>;
  /** Notes that the agent planned a route itself, so the app doesn't brief it again. */
  noteAgentRoute(): void;
};

export type AppScreen = 'ride' | 'history' | 'security' | 'device';

type Tool = Anthropic.Beta.BetaTool;
type ResultContent = Anthropic.Beta.BetaToolResultBlockParam['content'];

export type ToolOutcome = {
  content: ResultContent;
  isError?: boolean;
  /** Short past-tense line shown to the owner, e.g. "Armed Velo" */
  label: string;
};

const NO_INPUT = { type: 'object' as const, properties: {}, required: [], additionalProperties: false };
const CAMERA = { type: 'string' as const, enum: ['front', 'rear'] };

/** Kept in a fixed order: the tool list is part of the cached prompt prefix. */
const DEFINITIONS: Tool[] = [
  {
    name: 'get_surroundings',
    description:
      'What the cameras currently detect around the bike: each vehicle, cyclist or pedestrian with its direction and estimated distance. The same information is in the state snapshot; call this to re-check after time has passed.',
    input_schema: NO_INPUT,
  },
  {
    name: 'get_ride_status',
    description: 'Speed, the planned route, distance and time remaining, and the next turn.',
    input_schema: NO_INPUT,
  },
  {
    name: 'get_device_status',
    description: 'Whether Velo is armed or in ride mode, connection, battery, whether the alarm is sounding, and where the bike is parked.',
    input_schema: NO_INPUT,
  },
  {
    name: 'get_security_events',
    description: 'The most recent security history: when the bike was armed, disarmed or moved, and any crash detections. Use for questions like "what happened while I was away".',
    input_schema: NO_INPUT,
  },
  {
    name: 'get_ride_history',
    description: 'Recent rides with distance, duration, close passes and safety score (0 to 100, where 100 means no vehicle passed close), plus totals for the last seven days.',
    input_schema: NO_INPUT,
  },
  {
    name: 'look_through_camera',
    description:
      'Takes one picture from a Velo camera and returns it so you can describe the scene. Use when the owner asks what a camera can see, or who is near the bike. The picture is sent to you only when you call this.',
    input_schema: { type: 'object', properties: { camera: CAMERA }, required: ['camera'], additionalProperties: false },
  },
  {
    name: 'set_destination',
    description: 'Searches for a place or address and plans a cycling route to the best match. Returns the place chosen, the distance and the time. Does not start turn-by-turn; call start_navigation for that.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Place name or address as the owner said it' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'start_navigation',
    description: 'Starts turn-by-turn guidance along the planned route. If the bike is parked and armed, this also starts the ride.',
    input_schema: NO_INPUT,
  },
  {
    name: 'stop_navigation',
    description: 'Stops guidance and clears the route. The ride itself continues.',
    input_schema: NO_INPUT,
  },
  {
    name: 'arm_bike',
    description: 'Parks and arms Velo, so the alarm sounds if the bike is moved. This ends the current ride. The app asks the owner to confirm if the bike is still moving.',
    input_schema: NO_INPUT,
  },
  {
    name: 'disarm_bike',
    description: 'Disarms Velo and starts a ride. The app asks the owner to confirm first.',
    input_schema: NO_INPUT,
  },
  {
    name: 'silence_alarm',
    description: 'Stops the alarm if it is sounding.',
    input_schema: NO_INPUT,
  },
  {
    name: 'sound_alarm',
    description: "Sets off Velo's alarm on purpose. The app asks the owner to confirm first.",
    input_schema: NO_INPUT,
  },
  {
    name: 'find_my_bike',
    description:
      'Makes Velo beep and flash briefly, to spot the bike when it is nearby. To learn where the bike is, use locate_bike instead.',
    input_schema: NO_INPUT,
  },
  {
    name: 'locate_bike',
    description:
      "Where the bike is, from its own GPS: the street, how far it is from the owner, when it was last heard from, and whether it has moved from where it was parked. Once the bike is out of range this is its last known position, not a live one.",
    input_schema: NO_INPUT,
  },
  {
    name: 'show_bike_on_map',
    description:
      "Opens the Security screen, which shows a map of the bike's last known position with the owner's own position. Use when the owner wants to see where the bike is or go and find it; they will be on foot, so never plan a cycling route to it.",
    input_schema: NO_INPUT,
  },
  {
    name: 'speak_through_bike',
    description:
      "Says a short message out loud through the bike's own speaker, for whoever is next to the bike: for example asking someone to step away while the owner is elsewhere. Keep it calm, factual and under 25 words. Never accuse anyone of stealing, never threaten, and never describe skin colour, ethnicity, age, gender or body; clothing only. Not for talking to the owner.",
    input_schema: {
      type: 'object',
      properties: { message: { type: 'string', description: 'What the bike should say' } },
      required: ['message'],
      additionalProperties: false,
    },
  },
  {
    name: 'show_camera',
    description: 'Shows the live picture from a camera on the Ride screen for the owner to look at.',
    input_schema: { type: 'object', properties: { camera: CAMERA }, required: ['camera'], additionalProperties: false },
  },
  {
    name: 'set_view',
    description: 'Switches the Ride screen between "full" (everything, with the large camera picture) and "ride" (the quiet layout for riding).',
    input_schema: {
      type: 'object',
      properties: { view: { type: 'string', enum: ['full', 'ride'] } },
      required: ['view'],
      additionalProperties: false,
    },
  },
  {
    name: 'open_screen',
    description:
      'Switches the app to one of its screens: "ride" (the live view), "history" (past rides and security events), "security" (arming, the parked camera, find my bike) or "device" (connection and settings).',
    input_schema: {
      type: 'object',
      properties: { screen: { type: 'string', enum: ['ride', 'history', 'security', 'device'] } },
      required: ['screen'],
      additionalProperties: false,
    },
  },
];

export const TOOLS: Tool[] = DEFINITIONS.map((tool) => ({ ...tool, strict: true }));

// ---- Describing state in words --------------------------------------------------------

function describe(d: Detection) {
  const p = toWorld(d);
  const what = d.label === 'bicycle' ? 'cyclist' : d.label === 'person' ? 'pedestrian' : d.label;
  const side = p.x < -0.8 ? ' left' : p.x > 0.8 ? ' right' : '';
  const where = `${p.z > 0 ? 'behind' : 'ahead'}${side}`;
  return `${what} ${where}, about ${formatDistance(p.distance)}${isCloseVehicle(d) ? ' (close)' : ''}`;
}

function surroundings(world: AgentWorld) {
  const { state, connection } = world.device;
  if (connection === 'offline' || connection === 'connecting') {
    return 'Velo is not connected, so nothing is known about the surroundings.';
  }
  if (state.mode !== 'ride') return 'Velo is parked; traffic detection runs only while riding.';
  const seen = mergeCyclists(state.detections).sort((a, b) => toWorld(a).distance - toWorld(b).distance);
  return seen.length ? seen.map(describe).join('; ') : 'nothing detected by either camera';
}

function rideStatus(world: AgentWorld) {
  const { trip } = world;
  const speed = world.device.state.speedKmh;
  const { value, unit } = formatSpeed(speed ?? 0);
  const parts = [`speed ${speed == null ? 'unknown' : `${value} ${unit.toLowerCase()}`}`];
  if (!trip.destination) {
    parts.push('no destination set');
  } else if (trip.status === 'routing') {
    parts.push(`planning a route to ${trip.destination.name}`);
  } else if (trip.status === 'error') {
    parts.push(`route to ${trip.destination.name} failed: ${trip.error}`);
  } else if (trip.route && trip.navigating && trip.progress) {
    const p = trip.progress;
    parts.push(
      `following the route to ${trip.destination.name}, ${formatDistance(p.remaining)} and ${formatDuration(p.remainingTime)} left`,
    );
    if (p.arrived) parts.push('arrived');
    else if (p.offRoute) parts.push('currently off the route');
    else if (p.next) parts.push(`next: ${p.next.instruction} in ${formatDistance(p.distanceToNext)}`);
  } else if (trip.route) {
    parts.push(
      `route to ${trip.destination.name} planned (${formatDistance(trip.route.distance)}, ${formatDuration(trip.route.duration)}), guidance not started`,
    );
    const parking = trip.parking.find((spot) => spot.good && spot.fromDestination < 350);
    if (parking) parts.push(`good bike parking ${formatDistance(parking.fromDestination)} from the destination`);
    if (trip.closures.length) parts.push(`${trip.closures.length} closure(s) mapped near the route`);
  }
  return parts.join('; ');
}

const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function deviceStatus(world: AgentWorld) {
  const { state, connection } = world.device;
  const { parked } = world.security;
  // Without a live link, the mode and alarm are only what Velo last reported.
  const live = connection === 'connected' || connection === 'simulated';
  const known = live ? '' : 'last known before losing the connection: ';
  return [
    `connection: ${connection}`,
    `${known}${state.mode === 'security' ? 'parked and armed' : 'ride mode (not armed)'}`,
    `${known}alarm ${state.alarm ? 'SOUNDING' : 'quiet'}`,
    `battery: ${state.battery == null ? 'unknown' : `${Math.round(state.battery)}%`}`,
    parked ? `parked${parked.place ? ` at ${parked.place}` : ''} since ${clock(parked.ts)}` : null,
  ]
    .filter(Boolean)
    .join('; ');
}

function bikeLocation(world: AgentWorld) {
  const { lastSeen, parked } = world.security;
  if (!lastSeen) return "The bike's position is not known: Velo has not reported a GPS fix.";
  const live = world.device.connection === 'connected';
  const parts = [
    `${live ? 'The bike is' : 'The bike was last'} ${lastSeen.place ? `near ${lastSeen.place}` : 'at a known position'}`,
    live ? 'live from its GPS just now' : `last heard from at ${clock(lastSeen.ts)}; it is out of range, so it may have moved since`,
  ];
  const owner = world.trip.position;
  if (owner) {
    const away = distance(owner, lastSeen);
    // Under about 25 m, two GPS fixes can't be told apart.
    parts.push(away < 25 ? 'right by the owner' : `about ${formatDistance(away)} from the owner`);
  }
  if (parked) {
    const moved = distance(parked, lastSeen);
    parts.push(moved > 30 ? `it has MOVED about ${formatDistance(moved)} from where it was parked` : 'it is where it was parked');
  }
  return parts.join('; ');
}

const EVENT: Record<SecurityEntry['kind'], string> = {
  armed: 'armed',
  disarmed: 'disarmed',
  tamper: 'BIKE MOVED (alarm)',
  motion: 'motion nearby',
  siren: 'alarm sounded from the phone',
  crash: 'crash detected',
};

/** The text placed at the top of every message from the owner. */
export function stateSnapshot(world: AgentWorld) {
  return [
    `[Velo state at ${clock(Date.now())}]`,
    `Device: ${deviceStatus(world)}`,
    `Around the bike (camera estimates): ${surroundings(world)}`,
    `Ride: ${rideStatus(world)}`,
  ].join('\n');
}

// ---- Running a tool -------------------------------------------------------------------

const ok = (label: string, content: string): ToolOutcome => ({ label, content });
const failed = (label: string, content: string): ToolOutcome => ({ label, content, isError: true });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A picture from the device must come back within this long, or the question would hang. */
const PICTURE_TIMEOUT_MS = 5000;

async function pictureAsBase64(url: string) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), PICTURE_TIMEOUT_MS);
  const response = await fetch(url, { signal: abort.signal }).finally(() => clearTimeout(timer));
  if (!response.ok) throw new Error(`camera returned ${response.status}`);
  const blob = await response.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('could not read the picture'));
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.readAsDataURL(blob);
  });
}

/** Waits for route planning to finish, since setting a destination only starts it. */
async function routeSettled(nav: NavStore) {
  for (let i = 0; i < 60; i++) {
    const { status } = nav.getSnapshot();
    if (status === 'ready' || status === 'error') break;
    await wait(250);
  }
  return nav.getSnapshot();
}

export async function runTool(name: string, input: unknown, world: AgentWorld): Promise<ToolOutcome> {
  const args = (input ?? {}) as Record<string, string>;
  const { device, nav, trip } = world;

  switch (name) {
    case 'get_surroundings':
      return ok('Checked the cameras', surroundings(world));
    case 'get_ride_status':
      return ok('Checked the ride', rideStatus(world));
    case 'get_device_status':
      return ok('Checked Velo', deviceStatus(world));

    case 'get_security_events': {
      const lines = world.security.entries.slice(0, 12).map((e) => {
        const day = new Date(e.ts).toLocaleDateString([], { weekday: 'short' });
        return `${day} ${clock(e.ts)}: ${EVENT[e.kind]}${e.place ? ` at ${e.place}` : ''}${e.pictures.length ? ' (picture saved)' : ''}${e.description ? `. The camera showed: ${e.description}` : ''}`;
      });
      return ok('Checked security history', lines.length ? lines.join('\n') : 'No security events recorded.');
    }

    case 'get_ride_history': {
      const done = world.rides.filter((ride) => ride.endedAt != null);
      if (done.length === 0) return ok('Checked ride history', 'No rides recorded yet.');
      const weekAgo = Date.now() - 7 * 86400000;
      const week = done.filter((ride) => ride.startedAt > weekAgo);
      const lines = done.slice(0, 5).map((ride) => {
        const seconds = ((ride.endedAt ?? ride.lastSeen) - ride.startedAt) / 1000;
        return `${new Date(ride.startedAt).toLocaleDateString([], { weekday: 'short' })} ${clock(ride.startedAt)}${ride.destination ? ` to ${ride.destination}` : ''}: ${formatDistance(ride.distance)}, ${formatDuration(seconds)}, ${ride.closePasses} close passes, safety ${safetyScore(ride)}/100`;
      });
      const total = week.reduce((sum, ride) => sum + ride.distance, 0);
      const passes = week.reduce((sum, ride) => sum + ride.closePasses, 0);
      return ok(
        'Checked ride history',
        `Last 7 days: ${week.length} rides, ${formatDistance(total)}, ${passes} close passes.\nMost recent:\n${lines.join('\n')}`,
      );
    }

    case 'look_through_camera': {
      const camera: CameraId = args.camera === 'front' ? 'front' : 'rear';
      const label = `Looked through the ${camera} camera`;
      const url = device.connection === 'connected' ? device.snapshotUrlFor(camera) : null;
      if (!url) return failed(label, 'No camera picture is available: Velo is not connected, or it is the simulated device.');
      try {
        const data = await pictureAsBase64(url);
        return {
          label,
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
            { type: 'text', text: `Picture from the ${camera} camera, taken just now.` },
          ],
        };
      } catch (error) {
        return failed(label, `Could not get the picture: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }

    case 'set_destination': {
      const query = String(args.query ?? '').trim();
      if (!query) return failed('Set a destination', 'No place was given.');
      try {
        const near = trip.position ?? trip.origin ?? world.security.parked;
        const [place] = await searchPlaces(query, near);
        if (!place) return failed(`Searched for "${query}"`, `No place found for "${query}".`);
        world.noteAgentRoute();
        nav.setDestination(place);
        const settled = await routeSettled(nav);
        if (settled.status !== 'ready' || !settled.route) {
          return failed(`Set destination: ${place.name}`, `Found ${place.name}, but no cycling route could be planned: ${settled.error ?? 'still planning'}.`);
        }
        return ok(
          `Set destination: ${place.name}`,
          `Route planned to ${place.name}${place.detail ? ` (${place.detail})` : ''}: ${formatDistance(settled.route.distance)}, ${formatDuration(settled.route.duration)}. Guidance has not started.`,
        );
      } catch {
        return failed(`Searched for "${query}"`, 'The place search failed; the phone may be offline.');
      }
    }

    case 'start_navigation': {
      if (!nav.getSnapshot().route) return failed('Start navigation', 'There is no planned route. Set a destination first.');
      if (device.state.mode !== 'ride') {
        // Starting a ride disarms the bike, which always needs the owner's yes.
        if (!(await world.confirm('Disarm Velo and start the ride?'))) {
          return ok('Navigation not started', 'The owner declined; Velo is still armed and guidance has not started.');
        }
        device.setMode('ride');
      }
      await nav.start(false);
      return ok('Started navigation', `Guidance started to ${nav.getSnapshot().destination?.name ?? 'the destination'}.`);
    }

    case 'stop_navigation':
      nav.clear();
      return ok('Stopped navigation', 'Guidance stopped and the route cleared.');

    case 'arm_bike': {
      if (device.state.mode === 'security') return ok('Velo is already armed', 'Velo was already armed.');
      const moving = (device.state.speedKmh ?? 0) > 5;
      if (moving && !(await world.confirm('You are still moving. End the ride and arm Velo?'))) {
        return ok('Arming cancelled', 'The owner declined; Velo was not armed.');
      }
      nav.stop();
      device.setMode('security');
      return ok('Armed Velo', 'Velo is now parked and armed.');
    }

    case 'disarm_bike': {
      if (device.state.mode === 'ride') return ok('Velo is already disarmed', 'Velo was already disarmed.');
      if (!(await world.confirm('Disarm Velo?'))) return ok('Disarm cancelled', 'The owner declined; Velo is still armed.');
      device.setMode('ride');
      return ok('Disarmed Velo', 'Velo is disarmed and in ride mode.');
    }

    case 'silence_alarm':
      if (!device.state.alarm) return ok('Alarm was not sounding', 'The alarm was not sounding.');
      device.silenceAlarm();
      return ok('Silenced the alarm', 'The alarm has been silenced.');

    case 'sound_alarm': {
      if (!(await world.confirm("Sound Velo's alarm now?"))) return ok('Alarm cancelled', 'The owner declined; the alarm was not sounded.');
      world.security.soundAlarm();
      return ok('Sounded the alarm', 'The alarm is sounding.');
    }

    case 'find_my_bike':
      if (device.connection !== 'connected') return failed('Find my bike', 'Velo is not connected, so it cannot be made to beep.');
      device.chirp();
      return ok('Made Velo beep', 'Velo was told to beep and flash.');

    case 'locate_bike':
      return ok('Located the bike', bikeLocation(world));

    case 'show_bike_on_map':
      if (!world.security.lastSeen) {
        return failed('Show the bike on the map', "The bike's position is not known: Velo has not reported a GPS fix.");
      }
      world.ui.openScreen('security');
      return ok('Showing the bike on the map', `The map is showing. ${bikeLocation(world)}`);

    case 'speak_through_bike': {
      const message = String(args.message ?? '').trim().slice(0, 300);
      if (!message) return failed('Speak through the bike', 'No message was given.');
      if (!device.hasSpeaker) {
        return failed('Speak through the bike', 'The bike has no speaker connected, or Velo is out of range.');
      }
      const sent = await device.sayOnBike(message, true);
      return sent
        ? ok('Spoke through the bike', `The bike said: "${message}"`)
        : failed('Speak through the bike', 'The message could not be sent to the bike.');
    }

    case 'show_camera': {
      const camera: CameraId = args.camera === 'front' ? 'front' : 'rear';
      world.ui.openScreen('ride');
      world.ui.setFullView(true);
      world.ui.pinCamera(camera);
      return ok(`Showing the ${camera} camera`, `The ${camera} camera is now showing on the Ride screen.`);
    }

    case 'open_screen': {
      const screen = (['ride', 'history', 'security', 'device'] as const).find((s) => s === args.screen);
      if (!screen) return failed('Open a screen', `There is no screen called "${args.screen}".`);
      world.ui.openScreen(screen);
      return ok(`Opened ${screen === 'ride' ? 'the ride view' : screen}`, `The ${screen} screen is now showing.`);
    }

    case 'set_view':
      world.ui.openScreen('ride');
      world.ui.setFullView(args.view === 'full');
      return ok(`Switched to ${args.view === 'full' ? 'full view' : 'ride mode'}`, 'Done.');

    default:
      return failed(name, `Unknown tool: ${name}`);
  }
}
