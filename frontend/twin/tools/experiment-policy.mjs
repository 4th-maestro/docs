import { controllerObservation } from './experiment-input.mjs';

export const finite = (v, min, max = Infinity) => Number.isFinite(v) && v >= min && v <= max;

export function experimentActions(input, controller, requireSupport) {
  requireSupport(['always','occupancy'].includes(controller), '제어기 always 또는 occupancy');
  const groups = new Set();
  for (const room of input.rooms) {
    const group = input.settings.get(room).hvac?.shared_group;
    requireSupport(!group || !groups.has(group), '동일 공유 설비의 복수 호실 ' + group);
    if (group) groups.add(group);
  }
  return new Map(input.rooms.map(room => [room, roomActions(input, room, controller, requireSupport)]));
}

function roomActions(input, room, controller, requireSupport) {
  const hvac = input.settings.get(room).hvac;
  requireSupport(hvac && ['COOL', 'HEAT'].includes(hvac.mode) &&
    finite(hvac.capacity_W, 1) && finite(hvac.cop, 0.01) &&
    Array.isArray(hvac.setpoint_range_c) && hvac.setpoint_range_c.length === 2 &&
    finite(hvac.setpoint_range_c[0], 10, 40) && finite(hvac.setpoint_range_c[1], hvac.setpoint_range_c[0], 40) &&
    finite(hvac.setpoint_c, hvac.setpoint_range_c[0], hvac.setpoint_range_c[1]),
  room + ' 모드·용량·COP·설정온도 범위');
  requireSupport((hvac.min_on_minutes ?? 0) === 0 && (hvac.min_off_minutes ?? 0) === 0,
    room + ' 최소 운전·정지 제한');
  return input.conditions.get(room).map((_, index) => {
    const observed = controllerObservation(input, room, index);
    const active = controller === 'always' || observed.occupants > 0 || observed.planned_occupancy.some(row => row.occupants > 0);
    return { mode:active ? hvac.mode : 'OFF', setpoint_c:active ? hvac.setpoint_c : null };
  });
}
