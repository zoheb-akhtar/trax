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
import type { TurnDirection } from '@/nav/types';

/** After the last pedestrian has gone, wait this long before announcing pedestrians again. */
const PEDESTRIAN_QUIET_MS = 8000;

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
  const { navigating, progress } = useNav();
  const announcedCyclists = useRef(new Set<number>());
  const pedestrians = useRef({ present: false, clearedAt: 0 });
  const said = useRef({ turn: '', vehicle: false, alarm: false, offRoute: false, arrived: false });

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

  // A vehicle getting close: what it is, and where.
  const threat =
    state.mode === 'ride'
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
  useEffect(() => {
    const memory = said.current;
    if (threatLine && !memory.vehicle) say(threatLine, true);
    memory.vehicle = Boolean(threatLine);
  }, [threatLine]);

  // A cyclist coming up from behind: said once per rider, and never over a vehicle warning.
  const passing =
    state.mode === 'ride' && !threatLine
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
    state.mode === 'ride' && !threatLine
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
    if (state.alarm && !memory.alarm) say('Alarm. Your bike is being moved.', true);
    memory.alarm = state.alarm;
  }, [state.alarm]);

  return null;
}
