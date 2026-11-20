import { experimentActions, finite } from './experiment-policy.mjs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { toIdf } from '../pipeline/energyplus.js';
import { csvFields, localTime, STEP, validateWeather } from './experiment-input.mjs';

const DAY = 96;
const ADAPTER = 'ideal-loads-v1';
const requireSupport = (condition, message) => { if (!condition) throw new Error('EnergyPlus 실험 지원 범위: ' + message); };
const md = t => t.slice(5, 10).replace('-', '/');
const quarterClock = i => String(Math.floor(i / 4)).padStart(2, '0') + ':' + String(i % 4 * 15).padStart(2, '0');
const atQuarter = time => Number(time.slice(11, 13)) * 4 + Number(time.slice(14, 16)) / 15;

function dailySchedule(add, name, limits, input, values, fallback = 0) {
  const fields = [name, limits];
  const firstQuarter = atQuarter(localTime(input.start));
  const firstMidnight = input.start - firstQuarter * STEP;
  const daily = (date, day) => {
    fields.push('Through: ' + date, 'For: AllDays', 'Interpolate: No');
    day.forEach((value, i) => {
      if (i === DAY - 1 || value !== day[i + 1]) fields.push('Until: ' + quarterClock(i + 1), value);
    });
  };
  const previous = localTime(firstMidnight - DAY * STEP);
  if (md(previous) !== '12/31') daily(md(previous), Array(DAY).fill(fallback));
  for (let midnight = firstMidnight; midnight < input.end; midnight += DAY * STEP) {
    const base = (midnight - input.start) / STEP;
    daily(md(localTime(midnight)), Array.from({ length:DAY }, (_, i) => values[base + i] ?? fallback));
  }
  if (md(localTime(input.end - STEP)) !== '12/31') daily('12/31', Array(DAY).fill(fallback));
  add('Schedule:Compact', fields);
  return name;
}

export function buildEnergyPlusExperiment(input, controller) {
  requireSupport(input.initialization.energyplus === 'preceding_day_off' &&
    input.initialization.outside_window === 'off_zero_external_conditions', '초기화 프로필');
  const first = localTime(input.start), last = localTime(input.end - STEP);
  const preconditioning = localTime(input.start - DAY * STEP);
  requireSupport(preconditioning.slice(0, 4) === first.slice(0, 4), '실험 전날이 같은 달력 연도 안에 있어야 합니다');
  requireSupport(first.slice(0, 4) === last.slice(0, 4) &&
    !(first.slice(5,10) <= '02-29' && last.slice(5,10) >= '02-29' && Number(first.slice(0,4)) % 4 === 0),
  '단일 달력 연도, 윤일 제외');
  validateWeather(input.weather, input.start - DAY * STEP, input.start);
  const actions = experimentActions(input, controller, requireSupport);
  const profile = input.profile;
  const result = toIdf(input.building, { weatherFile:true, site:input.site, experiment:{
    rooms:actions,
    runPeriod:['Experiment', Number(preconditioning.slice(5,7)), Number(preconditioning.slice(8,10)), '',
      Number(last.slice(5,7)), Number(last.slice(8,10)), '', '', 'No', 'No', 'No', 'Yes', 'Yes', 'No'],
    writeZone({ zone, room, add }) {
      const rows = input.conditions.get(room.id), cfg = input.settings.get(room.id), hvac = cfg.hvac;
      const behavior = actions.get(room.id);
      requireSupport(rows.every(row => row.window_open_fraction === 0), room.id + ' 비영 창문 개방');
      requireSupport(cfg.ventilation_m3_s > 0 || rows.every(row => row.ventilation_fraction === 0), room.id + ' 기계환기 설계 유량');
      const schedule = (label, limits, values, fallback) => dailySchedule(add, zone + ' ' + label, limits, input, values, fallback);
      const people = schedule('Occupancy', 'Fraction', rows.map(row => cfg.capacity ? row.occupants / cfg.capacity : 0));
      const activity = schedule('Activity', 'Any', rows.map(row => profile.activities[row.activity].total_W_per_person), profile.activities[rows[0].activity].total_W_per_person);
      const heat = profile.activities[rows[0].activity];
      requireSupport(rows.every(row => {
        const current = profile.activities[row.activity];
        return current.sensible_fraction === heat.sensible_fraction && current.radiant_fraction === heat.radiant_fraction;
      }), room.id + ' 시간에 따라 바뀌는 사람 현열·복사 분배');
      add('People', [zone + ' People', zone, people, 'People', cfg.capacity, '', '', heat.radiant_fraction, heat.sensible_fraction, activity]);
      const lights = schedule('Lighting', 'Fraction', rows.map(row => row.lighting_fraction));
      add('Lights', [zone + ' Lights', zone, lights, 'LightingLevel', cfg.lighting_W, '', '',
        profile.lighting_return, profile.lighting_radiant, profile.lighting_visible]);
      const powers = rows.map(row => row.active_computers * profile.computer_active_W +
        (cfg.installed_computers - row.active_computers) * profile.computer_standby_W +
        cfg.other_base_W + cfg.other_variable_W * row.other_equipment_fraction);
      const max = powers.reduce((peak, value) => Math.max(peak, value), 0);
      const equipment = schedule('Equipment', 'Fraction', powers.map(value => max ? value / max : 0));
      add('ElectricEquipment', [zone + ' Equipment Gain', zone, equipment, 'EquipmentLevel', max, '', '',
        profile.equipment_latent, profile.equipment_radiant, profile.equipment_lost]);
      const vent = schedule('Ventilation', 'Fraction', rows.map(row => row.ventilation_fraction));
      if (cfg.ventilation_m3_s) add('ZoneVentilation:DesignFlowRate', [zone + ' Ventilation', zone, vent,
        'Flow/Zone', cfg.ventilation_m3_s, '', '', '', 'Intake', 0, 1, 1, 0, 0, 0]);
      const infiltration = cfg.infiltration_ach ?? 0;
      requireSupport(finite(infiltration, 0), room.id + ' 침기량');
      if (infiltration) add('ZoneInfiltration:DesignFlowRate', [zone + ' Infiltration', zone, 'Always On',
        'AirChanges/Hour', '', '', '', infiltration, 1, 0, 0, 0]);

      const avail = schedule('On', 'Fraction', behavior.map(action => Number(action.mode !== 'OFF')));
      const setpoint = schedule('Setpoint', 'Temperature', behavior.map(action => action.setpoint_c ?? hvac.setpoint_c), hvac.setpoint_c);
      const cooling = hvac.mode === 'COOL';
      const thermostat = cooling ? 'ThermostatSetpoint:SingleCooling' : 'ThermostatSetpoint:SingleHeating';
      add('Schedule:Constant', [zone + ' Control', 'ControlType', cooling ? 2 : 1]);
      add(thermostat, [zone + ' Setpoint Control', setpoint]);
      add('ZoneControl:Thermostat', [zone + ' Thermostat', zone, zone + ' Control', thermostat, zone + ' Setpoint Control']);
      add('ZoneHVAC:IdealLoadsAirSystem', [zone + ' Ideal', avail, zone + ' Supply', '', '', 50, 13, .0156, .0077,
        cooling ? 'NoLimit' : 'LimitCapacity', '', cooling ? '' : hvac.capacity_W,
        cooling ? 'LimitCapacity' : 'NoLimit', '', cooling ? hvac.capacity_W : '',
        cooling ? 'Always Off' : avail, cooling ? avail : 'Always Off', 'ConstantSensibleHeatRatio', .75, 'None']);
      add('ZoneHVAC:EquipmentList', [zone + ' HVAC', 'SequentialLoad', 'ZoneHVAC:IdealLoadsAirSystem', zone + ' Ideal', 1, 1]);
      add('ZoneHVAC:EquipmentConnections', [zone, zone + ' HVAC', zone + ' Supply', '', zone + ' Air Node', zone + ' Return']);
      add('Output:Variable', [zone, 'Zone Mean Air Temperature', 'Timestep']);
      add('Output:Variable', [zone + ' Ideal', 'Zone Ideal Loads Supply Air Total ' + (cooling ? 'Cooling' : 'Heating') + ' Energy', 'Timestep']);
    },
  } });
  return { ...result, actions };
}

function readExperimentResults(input, model, table) {
  const lines = table.trimEnd().split(/\r?\n/);
  const header = csvFields(lines.shift()).map(cell => cell.trim().toUpperCase());
  const columns = model.zones.zones.map(({ zone, room }) => {
    const temperature = header.findIndex(cell => cell.startsWith(zone.toUpperCase() + ':ZONE MEAN AIR TEMPERATURE'));
    const energy = header.findIndex(cell => cell.startsWith(zone.toUpperCase() + ' IDEAL:ZONE IDEAL LOADS SUPPLY AIR TOTAL ') && cell.includes(' ENERGY [J]'));
    if (temperature < 0 || energy < 0) throw new Error('EnergyPlus 결과 열 없음: ' + room);
    return { room, temperature, energy };
  }).sort((a, b) => a.room < b.room ? -1 : a.room > b.room ? 1 : 0);
  const firstQuarter = atQuarter(localTime(input.start));
  const expectedRows = DAY + Math.ceil((firstQuarter + (input.end - input.start) / STEP) / DAY) * DAY;
  if (lines.length !== expectedRows) throw new Error('EnergyPlus 결과 시각 격자가 일치하지 않습니다: ' + lines.length);
  const midnight = input.start - (firstQuarter + DAY) * STEP;
  const rows = [], summary = { occupied_room_minutes:0, occupied_out_of_range_room_minutes:0,
    hvac_estimated_energy_Wh:0, peak_estimated_hvac_power_W:0, mode_transitions:0 };
  const [low, high] = input.scenario.comfort.occupied_temperature_range_c;
  lines.forEach((line, rowIndex) => {
    const f = csvFields(line);
    const start = midnight + rowIndex * STEP, stamp = localTime(start), end = start + STEP;
    const expected = md(stamp) + ' ' + quarterClock(atQuarter(stamp) + 1) + ':00';
    if (f[0].trim().replace(/\s+/g, ' ') !== expected) throw new Error('EnergyPlus 결과 시각 불일치: ' + f[0]);
    if (start < input.start || start >= input.end) return;
    const index = rowIndex - firstQuarter - DAY;
    let power = 0;
    for (const col of columns) {
      const { room } = col, config = input.settings.get(room);
      const temperature = Number(f[col.temperature]), thermal = Number(f[col.energy]) / 3600;
      if (!f[col.temperature]?.trim() || !f[col.energy]?.trim() || !Number.isFinite(temperature) || !finite(thermal, 0))
        throw new Error('EnergyPlus 결과 값 오류: ' + room + ' ' + stamp);
      const occupants = input.conditions.get(room)[index].occupants;
      const actions = model.actions.get(room), action = actions[index], electrical = thermal / config.hvac.cop;
      if (occupants > 0) {
        summary.occupied_room_minutes += 15;
        if (temperature < low || temperature > high) summary.occupied_out_of_range_room_minutes += 15;
      }
      if (index && action.mode !== actions[index - 1].mode) summary.mode_transitions++;
      summary.hvac_estimated_energy_Wh += electrical;
      power += electrical * 4;
      rows.push({ timestamp:stamp, interval_end:localTime(end), room_id:room, occupants,
        interval_mean_indoor_temperature_c:temperature, requested_mode:action.mode, applied_mode:action.mode,
        requested_setpoint_c:action.setpoint_c, applied_setpoint_c:action.setpoint_c,
        hvac_thermal_energy_Wh:thermal, hvac_estimated_energy_Wh:electrical, hvac_estimated_mean_power_W:electrical * 4 });
    }
    summary.peak_estimated_hvac_power_W = Math.max(summary.peak_estimated_hvac_power_W, power);
  });
  return { rows, summary };
}

export function runEnergyPlusExperiment(input, { controller, executable, outDir }) {
  const started = performance.now();
  const model = buildEnergyPlusExperiment(input, controller);
  const id = randomUUID(), dir = path.resolve(outDir, id);
  mkdirSync(dir, { recursive:true });
  writeFileSync(path.join(dir, 'in.idf'), model.idf);
  writeFileSync(path.join(dir, 'weather.epw'), input.weather);
  const version = execFileSync(executable, ['--version'], { encoding:'utf8', cwd:dir }).trim();
  requireSupport(/\b24\.2\./.test(version), 'EnergyPlus 24.2 설치');
  const engineStarted = performance.now();
  const log = openSync(path.join(dir, 'engine.log'), 'w');
  try {
    execFileSync(executable, ['-r', '-w', 'weather.epw', '-d', '.', 'in.idf'],
      { cwd:dir, stdio:['ignore', log, log], timeout:15 * 60 * 1000 });
  } catch (error) {
    throw new Error('EnergyPlus 실행 실패. 로그: ' + path.join(dir, 'engine.log'), { cause:error });
  } finally {
    closeSync(log);
  }
  const engineMs = Math.round(performance.now() - engineStarted);
  const err = readFileSync(path.join(dir, 'eplusout.err'), 'utf8');
  if (/^\s*\*\*\s+(Severe|Fatal)\s+\*\*/m.test(err)) throw new Error('EnergyPlus 오류: ' + path.join(dir, 'eplusout.err'));
  const data = readExperimentResults(input, model, readFileSync(path.join(dir, 'eplusout.csv'), 'utf8'));
  const result = { run_id:id, scenario_id:input.scenario.scenario_id, input_checksum:input.checksum,
    engine:version, adapter_version:ADAPTER, controller_version:controller + '-v1',
    calibration:'none', energy_scope:'simulated rooms; fixed COP; excludes fan and shared plant electricity',
    engine_runtime_ms:engineMs, external_api_runtime_ms:0, elapsed_ms:Math.round(performance.now() - started), ...data };
  const file = path.join(dir, 'result.json');
  writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
  return { file, summary:result.summary };
}
