import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { localTime, STEP, validateWeather } from './experiment-input.mjs';
import { experimentActions, finite } from './experiment-policy.mjs';
import { step5R1C } from '../pipeline/rc5.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const AIR_HEAT_CAPACITY = 1206; // J/(m³·K), fixed density × specific heat
const requireSupport = (condition, message) => {
  if (!condition) throw new Error('5R1C 실험 지원 범위: ' + message);
};

// Air and surface nodes are algebraic. The mass node is integrated exactly
// for constant weather, gains, ventilation and HVAC power within the interval.
// 계산식은 pipeline/rc5.js로 옮겨 브라우저 즉시 계산(what-if)과 같이 씀 — 구간 길이 기본값 900초 = STEP
export { step5R1C };

function roomModel(input, room) {
  const config = input.settings.get(room);
  const rc = config.thermal_5r1c;
  requireSupport(rc && ['air_surface_W_K','mass_surface_W_K','mass_outdoor_W_K','mass_capacity_J_K','volume_m3']
    .every(k => finite(rc[k], 0.001)) &&
    ['window_outdoor_W_K','solar_effective_area_m2'].every(k => finite(rc[k], 0)) &&
    typeof rc.source === 'string' && rc.source.trim(), room + ' 버전 고정 열 파라미터(thermal_5r1c) 및 출처');
  requireSupport(finite(config.infiltration_ach ?? 0, 0), room + ' 침기량');
  const rows = input.conditions.get(room);
  requireSupport(rows.every(row => row.window_open_fraction === 0), room + ' 비영 창문 개방');
  requireSupport(config.ventilation_m3_s > 0 || rows.every(row => row.ventilation_fraction === 0), room + ' 기계환기 설계 유량');
  return { config, rc, rows };
}

function forcingAt(weather, row, rc, config, profile) {
  const solar = weather.global_horizontal_W_m2 * rc.solar_effective_area_m2;
  let air = 0, radiant = solar;
  if (row) {
    const activity = profile.activities[row.activity];
    const people = row.occupants * activity.total_W_per_person * activity.sensible_fraction;
    const lights = config.lighting_W * row.lighting_fraction;
    const equipment = row.active_computers * profile.computer_active_W +
      (config.installed_computers - row.active_computers) * profile.computer_standby_W +
      config.other_base_W + config.other_variable_W * row.other_equipment_fraction;
    const peopleRadiant = people * activity.radiant_fraction;
    const lightingRadiant = lights * (profile.lighting_radiant + profile.lighting_visible);
    air = people - peopleRadiant + lights * (1 - profile.lighting_return) - lightingRadiant +
      equipment * (1 - profile.equipment_latent - profile.equipment_lost - profile.equipment_radiant);
    radiant += peopleRadiant + lightingRadiant + equipment * profile.equipment_radiant;
  }
  const ventilation = config.ventilation_m3_s * (row?.ventilation_fraction ?? 0);
  const infiltration = (config.infiltration_ach ?? 0) * rc.volume_m3 / 3600;
  return { outdoorC:weather.outdoor_c, airExchangeWK:AIR_HEAT_CAPACITY * (ventilation + infiltration),
    airGainW:air, surfaceGainW:radiant / 2, massGainW:radiant / 2 };
}

function applyAction(rc, mass, forcing, action, capacity) {
  const free = step5R1C(rc, mass, forcing);
  if (action.mode === 'OFF') return { ...free, thermalW:0 };
  const sign = action.mode === 'COOL' ? -1 : 1;
  const remaining = (action.setpoint_c - free.meanAirC) * sign;
  if (remaining <= 0) return { ...free, thermalW:0 };
  const full = step5R1C(rc, mass, forcing, sign * capacity);
  const change = (full.meanAirC - free.meanAirC) * sign;
  if (change <= remaining) return { ...full, thermalW:capacity };
  const thermalW = capacity * remaining / change;
  return { ...step5R1C(rc, mass, forcing, sign * thermalW), thermalW };
}

export function simulate5R1C(input, controller) {
  requireSupport(input.initialization.rc5r1c === 'preceding_day_off_outdoor_seed' &&
    input.initialization.outside_window === 'off_zero_external_conditions', '초기화 프로필 rc5r1c');
  const actions = experimentActions(input, controller, requireSupport);
  const warmupStart = Date.parse(localTime(input.start).slice(0, 10) + 'T00:00:00+09:00') - DAY;
  const hourly = new Map();
  validateWeather(input.weather, warmupStart, input.end, hourly);
  const weatherAt = ms => hourly.get(Math.floor(ms / HOUR) * HOUR);
  const rooms = input.rooms.map(room => {
    const { config, rc, rows } = roomModel(input, room);
    let mass = weatherAt(warmupStart).outdoor_c;
    for (let t = warmupStart; t < input.start; t += STEP)
      mass = step5R1C(rc, mass, forcingAt(weatherAt(t), null, rc, config, input.profile)).massC;
    return { room, config, rc, rows, mass, actions:actions.get(room) };
  });
  const rows = [];
  const summary = { occupied_room_minutes:0, occupied_out_of_range_room_minutes:0,
    hvac_estimated_energy_Wh:0, peak_estimated_hvac_power_W:0, mode_transitions:0 };
  const [low, high] = input.scenario.comfort.occupied_temperature_range_c;
  for (let t = input.start, index = 0; t < input.end; t += STEP, index++) {
    let buildingPower = 0;
    const weather = weatherAt(t), timestamp = localTime(t), interval_end = localTime(t + STEP);
    for (const state of rooms) {
      const row = state.rows[index], action = state.actions[index], hvac = state.config.hvac;
      const forcing = forcingAt(weather, row, state.rc, state.config, input.profile);
      const result = applyAction(state.rc, state.mass, forcing, action, hvac.capacity_W);
      requireSupport([result.massC, result.meanAirC, result.thermalW].every(Number.isFinite), state.room + ' 열 계산 결과');
      state.mass = result.massC;
      const power = result.thermalW / hvac.cop;
      const electrical = power * STEP / HOUR;
      if (row.occupants > 0) {
        summary.occupied_room_minutes += 15;
        if (result.meanAirC < low || result.meanAirC > high) summary.occupied_out_of_range_room_minutes += 15;
      }
      if (index && action.mode !== state.actions[index - 1].mode) summary.mode_transitions++;
      summary.hvac_estimated_energy_Wh += electrical;
      buildingPower += power;
      rows.push({ timestamp, interval_end, room_id:state.room, occupants:row.occupants,
        interval_mean_indoor_temperature_c:result.meanAirC, requested_mode:action.mode, applied_mode:action.mode,
        requested_setpoint_c:action.setpoint_c, applied_setpoint_c:action.setpoint_c,
        hvac_thermal_energy_Wh:result.thermalW * STEP / HOUR, hvac_estimated_energy_Wh:electrical, hvac_estimated_mean_power_W:power });
    }
    summary.peak_estimated_hvac_power_W = Math.max(summary.peak_estimated_hvac_power_W, buildingPower);
  }
  return { rows, summary };
}

export function run5R1CExperiment(input, { controller, outDir }) {
  const started = performance.now();
  const data = simulate5R1C(input, controller);
  const elapsed = performance.now() - started;
  const id = randomUUID();
  const dir = path.resolve(outDir, id);
  mkdirSync(dir, { recursive:true });
  const result = { run_id:id, scenario_id:input.scenario.scenario_id, input_checksum:input.checksum,
    engine:'5R1C', adapter_version:'rc5r1c-v1', controller_version:controller + '-v1',
    calibration:'registry parameters; no automatic calibration',
    energy_scope:'simulated rooms; sensible thermal load and fixed COP; excludes fan and shared plant electricity',
    engine_runtime_ms:elapsed, external_api_runtime_ms:0, elapsed_ms:performance.now() - started, ...data };
  const file = path.join(dir, 'result.json');
  writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
  return { file, summary:result.summary };
}
