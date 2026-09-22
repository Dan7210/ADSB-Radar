import { fromLonLat } from 'ol/proj.js';
import { offset } from 'ol/sphere.js';

const KNOTS_TO_METERS_PER_SECOND = 0.514444;
const CORRECTION_TIME_SECONDS = 4;
const MAX_FRAME_SECONDS = 0.1;
const MIN_REASONABLE_PROJECTED_SPEED = 90;
const CORRECTION_SPEED_ALLOWANCE = 100;

function velocity(aircraft, lonLat) {
  const speed = Math.max(0, Number(aircraft.gs) || 0) * KNOTS_TO_METERS_PER_SECOND;
  const bearing = (Number(aircraft.track) || 0) * Math.PI / 180;
  const next = fromLonLat(offset(lonLat, speed, bearing));
  const current = fromLonLat(lonLat);
  return [next[0] - current[0], next[1] - current[1]];
}

export function estimatedLonLat(aircraft) {
  const lonLat = [Number(aircraft.lon), Number(aircraft.lat)];
  const age = Math.max(0, Number(aircraft.positionAge ?? aircraft.seen_pos ?? aircraft.seen) || 0);
  const distance = Math.max(0, Number(aircraft.gs) || 0) * KNOTS_TO_METERS_PER_SECOND * age;
  const bearing = (Number(aircraft.track) || 0) * Math.PI / 180;
  return offset(lonLat, distance, bearing);
}

export function updateMotion(motion, aircraft, frameTime) {
  const lonLat = estimatedLonLat(aircraft);
  const target = fromLonLat(lonLat);
  const nextVelocity = velocity(aircraft, lonLat);

  if (!motion) {
    return {
      rendered: [...target],
      target,
      velocity: nextVelocity,
      targetTime: frameTime,
      frameTime,
    };
  }

  motion.target = target;
  motion.velocity = nextVelocity;
  motion.targetTime = frameTime;
  return motion;
}

export function stepMotion(motion, frameTime) {
  const elapsed = Math.max(0, (frameTime - motion.targetTime) / 1000);
  const target = [
    motion.target[0] + motion.velocity[0] * elapsed,
    motion.target[1] + motion.velocity[1] * elapsed,
  ];
  const delta = Math.min(MAX_FRAME_SECONDS, Math.max(0, (frameTime - motion.frameTime) / 1000));
  const projected = [
    motion.rendered[0] + motion.velocity[0] * delta,
    motion.rendered[1] + motion.velocity[1] * delta,
  ];
  const correction = 1 - Math.exp(-delta / CORRECTION_TIME_SECONDS);
  const corrected = [
    projected[0] + (target[0] - projected[0]) * correction,
    projected[1] + (target[1] - projected[1]) * correction,
  ];
  const apparentSpeed = delta > 0
    ? Math.hypot(corrected[0] - motion.rendered[0], corrected[1] - motion.rendered[1]) / delta
    : 0;
  const reportedSpeed = Math.hypot(motion.velocity[0], motion.velocity[1]);
  const reasonableSpeed = Math.max(MIN_REASONABLE_PROJECTED_SPEED,
    reportedSpeed + CORRECTION_SPEED_ALLOWANCE);

  // A large stale-position correction looks like an impossible acceleration.
  // Prefer one honest position snap over several seconds of false high-speed flight.
  motion.rendered = apparentSpeed > reasonableSpeed ? target : corrected;
  motion.frameTime = frameTime;
  return motion.rendered;
}
