import { useEffect, useRef } from 'react';

import { useDevice } from '@/device/device-provider';
import {
  isCloseVehicle,
  isNearCyclist,
  isPedestrianAhead,
  mergeCyclists,
  toWorld,
} from '@/device/geometry';
import { say } from '@/lib/voice';
import { formatDistance } from '@/nav/geo';
import { useNav } from '@/nav/nav-provider';
import { useSecurity } from '@/security/security-provider';
import type { TurnDirection } from '@/nav/types';

/** After the last pedestrian has gone, wait this long before announcing pedestrians again. */
const PEDESTRIAN_QUIET_MS = 8000;

/** A vehicle that comes back within this long of leaving is the same approach, not a new one. */
const VEHICLE_QUIET_MS = 3000;

/** The device's warnings worth saying out loud while riding. Signs, lights and the like stay silent. */
const SPOKEN_KINDS = new Set([
  'collision',
  'rear_collision',
  'close_pass',
  'right_hook',
  'oncoming',
  'emergency',
  'vehicle_behind',
  'cyclist_behind',
  'blind_spot',
  'crossing',
  'in_path',
  'lead_braking',
  'vehicle_in_bike_lane',
  'door_zone',
]);
/** One device warning at a time: a new one waits this long after the last, unless it's danger. */
const ALERT_GAP_MS = 3000;
/** The same kind of warning isn't repeated sooner than this. */
const SAME_KIND_MS = 8000;

const TURN: Partial<Record<TurnDirection, string>> = {
  left: 'turn left',
  right: 'turn right',
  'slight-left': 'keep left',
  'slight-right': 'keep right',
  'sharp-left': 'turn sharp left',
  'sharp-right': 'turn sharp right',
  uturn: 'turn around',
  roundabout: 'enter the roundabout',
  arrive: 'you will arrive',
};

/** Spoken "in 200 metres" style, without abbreviations a voice would misread. */
const spoken = (metres: number) =>
  formatDistance(metres)
    .replace(/ km$/, ' kilometres')
    .replace(/ m$/, ' metres')
    .replace(/ mi$/, ' miles')
    .replace(/ ft$/, ' feet');

/**
 * Speaks the few things a rider needs to hear, so they don't have to look down:
 * the next turn, a vehicle closing in, a cyclist about to pass, pedestrians in the way,
 * and the alarm. Renders nothing.
 */
export function VoiceAlerts() {
  const { state } = useDevice();
  const { entries } = useSecurity();
  const { navigating, progress } = useNav();
  const announcedCyclists = useRef(new Set<number>());
  const pedestrians = useRef({ present: false, clearedAt: 0 });
  const said = useRef({ turn: '', alarm: false, offRoute: false, arrived: false });

  // Turns: once when it comes into range, once more just before it.
  const next = progress?.next;
  const distance = progress?.distanceToNext ?? 0;
  const stage = distance < 60 ? 'now' : distance < 220 ? 'soon' : 'far';
  const turnKey = navigating && next && !progress?.offRoute ? `${next.at}:${stage}` : '';
  useEffect(() => {
    const memory = said.current;
    if (!turnKey || turnKey === memory.turn || !next || stage === 'far') {
      if (!turnKey) memory.turn = '';
      return;
    }
    memory.turn = turnKey;
    const action = TURN[next.direction];
    if (!action) return;
    const onto = next.street && next.direction !== 'arrive' ? ` onto ${next.street}` : '';
    say(stage === 'now' ? `${action}${onto}` : `In ${spoken(distance)}, ${action}${onto}`);
    // Announce on the stage change only, not on every metre travelled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnKey]);

  const arrived = Boolean(navigating && progress?.arrived);
  const offRoute = Boolean(navigating && progress?.offRoute);
  useEffect(() => {
    const memory = said.current;
    if (arrived && !memory.arrived) say('You have arrived');
    if (offRoute && !memory.offRoute) say('Off route. Finding a new way.');
    memory.arrived = arrived;
    memory.offRoute = offRoute;
  }, [arrived, offRoute]);

  // A device that works out its own warnings (the perception brain) is listened to instead of
  // the app's estimates from the boxes, so nothing is said twice.
  const ownWarnings = state.alerts === null;

  const spokenAlert =
    state.mode === 'ride' && state.alerts
      ? state.alerts.find((a) => SPOKEN_KINDS.has(a.kind) && a.level !== 'info')
      : undefined;
  const alertKey = spokenAlert ? `${spokenAlert.id}|${spokenAlert.kind}` : '';
  const alertMemory = useRef({ lastAt: 0, ids: new Set<string>(), kinds: new Map<string, number>() });
  useEffect(() => {
    if (!spokenAlert) return;
    const memory = alertMemory.current;
    const now = Date.now();
    if (memory.ids.has(alertKey)) return;
    const danger = spokenAlert.level === 'danger';
    if (!danger && now - memory.lastAt < ALERT_GAP_MS) return;
    if (now - (memory.kinds.get(spokenAlert.kind) ?? 0) < SAME_KIND_MS) return;
    if (say(spokenAlert.text, danger)) {
      memory.ids.add(alertKey);
      memory.kinds.set(spokenAlert.kind, now);
      memory.lastAt = now;
    }
    // Said when a new warning comes to the top, not on every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alertKey]);

  // A vehicle getting close: what it is, and where.
  const threat =
    state.mode === 'ride' && ownWarnings
      ? mergeCyclists(state.detections)
          .filter(isCloseVehicle)
          .map((d) => ({ label: d.label, ...toWorld(d) }))
          .sort((a, b) => a.distance - b.distance)[0]
      : undefined;
  const threatLine = threat
    ? `${threat.label} ${threat.z > 0 ? 'behind' : 'ahead'}${
        threat.x < -0.5 ? ', on your left' : threat.x > 0.5 ? ', on your right' : ''
      }`
    : '';
  // A car hovering around the "close" distance flickers in and out of range; it is announced
  // again only after the way has been clear for a few seconds.
  const vehicle = useRef({ present: false, goneAt: 0 });
  useEffect(() => {
    const memory = vehicle.current;
    const now = Date.now();
    if (!threatLine) {
      if (memory.present) memory.goneAt = now;
      memory.present = false;
      return;
    }
    if (memory.present) return; // the same approach, perhaps now on the other side
    if (now - memory.goneAt < VEHICLE_QUIET_MS) {
      memory.present = true;
      return;
    }
    memory.present = say(threatLine, true);
  }, [threatLine]);

  // A cyclist coming up from behind: said once per rider, and never over a vehicle warning.
  const passing =
    state.mode === 'ride' && ownWarnings && !threatLine
      ? mergeCyclists(state.detections).find((d) => isNearCyclist(d) && toWorld(d).z > 0)
      : undefined;
  const passingId = passing?.id;
  useEffect(() => {
    if (passingId === undefined || announcedCyclists.current.has(passingId)) return;
    announcedCyclists.current.add(passingId);
    say('Cyclist behind');
  }, [passingId]);

  // Pedestrians in the way: one line however many there are, said when the first appears
  // and not again until the way has been clear for a while. Never over a vehicle warning.
  const walkers =
    state.mode === 'ride' && ownWarnings && !threatLine
      ? mergeCyclists(state.detections).filter(isPedestrianAhead).length
      : 0;
  const walkersKey = walkers === 0 ? 'none' : walkers === 1 ? 'one' : 'many';
  useEffect(() => {
    const memory = pedestrians.current;
    const now = Date.now();
    if (walkersKey === 'none') {
      if (memory.present) memory.clearedAt = now;
      memory.present = false;
      return;
    }
    if (memory.present) return; // already announced this group
    memory.present = true;
    if (now - memory.clearedAt < PEDESTRIAN_QUIET_MS) return;
    say(walkersKey === 'one' ? 'Pedestrian ahead' : 'Pedestrians ahead');
  }, [walkersKey]);

  useEffect(() => {
    const memory = said.current;
    if (state.alarm && !memory.alarm) {
      // Set off on purpose from the phone, or by someone moving the bike?
      const newest = entries[0];
      const fromPhone = newest?.kind === 'siren' && Date.now() - newest.ts < 15000;
      say(fromPhone ? 'Alarm sounding.' : 'Alarm. Your bike is being moved.', true);
    }
    memory.alarm = state.alarm;
    // Only the alarm switching on matters; the log is read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.alarm]);

  return null;
}
