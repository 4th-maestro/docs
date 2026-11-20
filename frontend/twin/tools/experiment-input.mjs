import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const STEP = 900_000;
const COLUMNS = ['timestamp', 'room_id', 'occupants', 'activity', 'lighting_fraction', 'active_computers',
  'other_equipment_fraction', 'window_open_fraction', 'ventilation_fraction'];
const ID = /^[a-zA-Z0-9_.-]+$/;
const OFFSET = 9 * 60 * 60 * 1000;
const getOwn = (obj, key) => obj && Object.hasOwn(obj, key) ? obj[key] : undefined;
const need = (valid, field) => { if (!valid) throw new Error('실험 입력 오류: ' + field); };
const json = source => JSON.parse(source.replace(/^\uFEFF/, ''));
const number = (v, min = 0, max = Infinity) => Number.isFinite(v) && min <= v && v <= max;
const integer = (v, min = 0, max = Infinity) => Number.isSafeInteger(v) && number(v, min, max);
const id = (v, field) => { need(typeof v === 'string' && ID.test(v), field); return v; };
const object = (v, field) => { need(v && typeof v === 'object' && !Array.isArray(v), field); return v; };
export const localTime = ms => new Date(ms + OFFSET).toISOString().slice(0, 19) + '+09:00';

function timestamp(v) {
  need(typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:(00|15|30|45):00(?:\.0+)?\+09:00$/.test(v), '15분 KST 시각 ' + v);
  const ms = Date.parse(v);
  need(Number.isFinite(ms) && localTime(ms) === v.replace(/\.0+(?=\+)/, ''), '유효한 달력 시각 ' + v);
  return ms;
}

export function csvFields(line) {
  const fields = line.match(/(?:^|,)(?:"(?:[^"]|"")*"|[^",]*)/g);
  need(fields && fields.join('') === line, 'CSV 구문');
  return fields.map((v, i) => {
    const field = i ? v.slice(1) : v;
    return field.startsWith('"') ? field.slice(1, -1).replace(/""/g, '"') : field;
  });
}

function grid(source, columns, start, end, rooms, convert) {
  const lines = source.replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/);
  need(csvFields(lines.shift()).join(',') === columns.join(','), 'CSV 헤더 ' + columns.join(','));
  need(lines.length === (end - start) / STEP * rooms.length, 'CSV 행 수 ' + lines.length);
  const byRoom = new Map(rooms.map(room => [room, []]));
  lines.forEach((line, i) => {
    const row = csvFields(line);
    const time = start + Math.floor(i / rooms.length) * STEP;
    const room = rooms[i % rooms.length];
    need(row.length === columns.length && row.every(v => v.trim() !== '') &&
      timestamp(row[0]) === time && row[1] === room, 'CSV ' + (i + 2) + '행의 시각·공간·필드');
    byRoom.get(room).push(convert(row, room, i + 2));
  });
  return byRoom;
}

export function validateWeather(source, start, end, hourly = null) {
  const lines = source.trimEnd().split(/\r?\n/);
  const location = csvFields(lines[0]);
  need(location[0] === 'LOCATION' && +location[8] === 9, 'EPW 표준시 +09:00');
  need(number(+location[6], -90, 90) && number(+location[7], -180, 180) && number(+location[9], -500, 9000), 'EPW 위치');
  const period = csvFields(lines[7] || '');
  need(period[0] === 'DATA PERIODS' && +period[1] === 1 && +period[2] === 1, 'EPW 시간당 1행, 단일 데이터 기간');
  const keys = new Map();
  for (const line of lines.slice(8)) {
    const f = csvFields(line);
    const [, month, day, hour, minute] = f.map(Number);
    const key = month + '/' + day + '/' + hour;
    need(f.length >= 35 && integer(hour, 1, 24) && (minute === 60 || minute === 0) && !keys.has(key), 'EPW 시간 중복 또는 레코드 형식 ' + key);
    keys.set(key, { fields:f, index:keys.size });
  }
  const firstDay = start - ((start + OFFSET) % 86_400_000);
  const lastDay = end - STEP - ((end - STEP + OFFSET) % 86_400_000);
  const limits = [[6,-70,70], [7,-70,70], [8,0,110], [9,31_000,120_000],
    [13,0,9_998], [14,0,9_998], [15,0,9_998], [20,0,360], [21,0,40]];
  let previousIndex = null;
  for (let ms = firstDay; ms < lastDay + 86_400_000; ms += 3_600_000) {
    const t = new Date(ms + OFFSET);
    const key = (t.getUTCMonth() + 1) + '/' + t.getUTCDate() + '/' + (t.getUTCHours() + 1);
    const row = keys.get(key), f = row?.fields;
    need(row && (previousIndex === null || row.index === (previousIndex + 1) % keys.size), 'EPW 기상 시각 순서 ' + key);
    previousIndex = row.index;
    need(f && limits.every(([i, min, max]) => f[i].trim() && number(+f[i], min, max)), 'EPW 기상값 누락 또는 범위 오류 ' + key);
    hourly?.set(ms, { outdoor_c:+f[6], global_horizontal_W_m2:+f[13] });
  }
  return { name:'EPW site', lat:+location[6], lon:+location[7], tz:9, elev:+location[9] };
}

export function loadExperiment(scenarioFile, registryFile, { weatherOverride, weatherSource } = {}) {
  const digest = createHash('sha256');
  const read = file => {
    const content = readFileSync(file);
    digest.update(String(content.length) + ':').update(content);
    return content.toString('utf8');
  };
  const relative = (base, file) => {
    need(typeof file === 'string' && file.trim() && !path.isAbsolute(file) && !/^[a-z]:/i.test(file), '상대 파일 경로 ' + file);
    return path.resolve(path.dirname(base), file);
  };
  const scenario = object(json(read(scenarioFile)), 'scenario.json');
  need(scenario.schema_version === '1.0' && scenario.timezone === 'Asia/Seoul' &&
    scenario.step_minutes === 15 && integer(scenario.random_seed), 'schema_version, timezone, step_minutes, random_seed');
  for (const key of ['scenario_id', 'building_id', 'building_revision', 'load_profile_id', 'load_profile_revision', 'initialization_profile_id']) id(scenario[key], key);
  const start = timestamp(scenario.start_time), end = timestamp(scenario.end_time);
  need(start < end, 'start_time < end_time');
  const ids = scenario.room_ids;
  need(Array.isArray(ids) && ids.length && new Set(ids).size === ids.length, 'room_ids');
  const rooms = ids.map(room => id(room, 'room_ids')).sort();
  const comfort = scenario.comfort?.occupied_temperature_range_c;
  need(Array.isArray(comfort) && comfort.length === 2 && comfort.every(Number.isFinite) &&
    comfort[0] < comfort[1] && ['comfort_first','balanced','energy_first'].includes(scenario.comfort.priority), 'comfort');
  const info = object(scenario.controller_information, 'controller_information');
  need(integer(info.schedule_lookahead_minutes) && info.schedule_lookahead_minutes % 15 === 0 &&
    info.weather_forecast_enabled === false, 'controller_information');
  for (const key of ['weather','occupancy','loads']) need(typeof scenario.provenance?.[key] === 'string' && scenario.provenance[key].trim(), 'provenance.' + key);
  if (scenario.generator !== undefined) {
    id(scenario.generator?.id, 'generator.id');
    need(typeof scenario.generator.version === 'string' && scenario.generator.version.trim(), 'generator.version');
    object(scenario.generator.parameters, 'generator.parameters');
  }

  const registry = json(read(registryFile));
  const lookup = (group, key, revision) => {
    const entry = getOwn(registry[group], key);
    return object(revision === undefined ? entry : getOwn(entry, revision), group + '/' + key + '/' + (revision ?? ''));
  };
  const buildingRef = lookup('buildings', scenario.building_id, scenario.building_revision);
  const building = json(read(relative(registryFile, buildingRef.file)));
  need(building.schema === 'twin.building/v1' && building.building?.id === scenario.building_id, 'building.json ID 또는 스키마');
  const roomIndex = new Map(building.floors.flatMap(f => f.rooms.filter(r => r.type === 'room').map(r => [r.id, r])));
  const settings = new Map(rooms.map(room => {
    const record = roomIndex.get(room);
    need(record && integer(record.capacity), room + ' 정원');
    const config = object(getOwn(buildingRef.rooms, room), room + ' 설비 설정');
    need(integer(config.installed_computers) && ['lighting_W','other_base_W','other_variable_W','ventilation_m3_s'].every(k => number(config[k])), room + ' 설치 부하');
    return [room, { ...config, capacity:record.capacity }];
  }));
  const profile = lookup('load_profiles', scenario.load_profile_id, scenario.load_profile_revision);
  for (const key of ['lighting_radiant','lighting_visible','lighting_return','equipment_latent','equipment_radiant','equipment_lost'])
    need(number(profile[key], 0, 1), '부하 프로필 ' + key);
  need(profile.lighting_radiant + profile.lighting_visible + profile.lighting_return <= 1 &&
    profile.equipment_latent + profile.equipment_radiant + profile.equipment_lost <= 1 &&
    number(profile.computer_standby_W) && number(profile.computer_active_W, profile.computer_standby_W), '부하 프로필 전력·발열 분배');
  const initialization = lookup('initialization_profiles', scenario.initialization_profile_id);
  need(scenario.weather?.date_mapping === 'month_day', 'weather.date_mapping');
  const epwPath = relative(scenarioFile, scenario.weather.file);
  const weather = weatherOverride ?? read(epwPath);
  if (weatherOverride !== undefined) {
    digest.update(String(Buffer.byteLength(weather)) + ':').update(weather);
    if (weatherSource) scenario.provenance.weather = weatherSource;
  }
  const site = validateWeather(weather, start, end);

  const numeric = v => /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(v.trim()) ? Number(v) : NaN;
  const occupancy = (v, room, line) => {
    const n = numeric(v);
    need(integer(n, 0, settings.get(room).capacity), 'CSV ' + line + '행 인원');
    return n;
  };
  const conditions = grid(read(relative(scenarioFile, scenario.conditions_file)), COLUMNS, start, end, rooms, (row, room, line) => {
    const [, , people, activity, lighting, computers, other, window, ventilation] = row;
    need(Object.hasOwn(profile.activities ?? {}, activity), 'CSV ' + line + '행 활동 코드');
    const heat = object(profile.activities[activity], '활동 프로필 ' + activity);
    need(number(heat.total_W_per_person) && number(heat.sensible_fraction, 0, 1) &&
      number(heat.radiant_fraction, 0, 1), '활동 프로필 발열 ' + activity);
    const [light, pc, equipment, open, vent] = [lighting, computers, other, window, ventilation].map(numeric);
    need([light, equipment, open, vent].every(n => number(n, 0, 1)) &&
      integer(pc, 0, settings.get(room).installed_computers), 'CSV ' + line + '행 사용률 또는 컴퓨터 대수');
    return { occupants:occupancy(people, room, line), activity, lighting_fraction:light, active_computers:pc,
      other_equipment_fraction:equipment, window_open_fraction:open, ventilation_fraction:vent };
  });
  const planned = info.planned_occupancy_file === undefined ? null :
    grid(read(relative(scenarioFile, info.planned_occupancy_file)), COLUMNS.slice(0, 3), start, end, rooms,
      (row, room, line) => occupancy(row[2], room, line));
  return { scenario, start, end, rooms, settings, building, profile, initialization, weather, site, conditions, planned,
    checksum:digest.digest('hex') };
}

export function controllerObservation(input, room, index) {
  const steps = input.scenario.controller_information.schedule_lookahead_minutes / 15;
  const actual = input.conditions.get(room);
  const scheduled = input.planned?.get(room);
  return {
    timestamp:localTime(input.start + index * STEP),
    room_id:room,
    occupants:actual[index].occupants,
    planned_occupancy:Array.from({ length:Math.min(steps, actual.length - index) }, (_, offset) => ({
      timestamp:localTime(input.start + (index + offset) * STEP),
      occupants:scheduled ? scheduled[index + offset] : actual[index + offset].occupants,
    })),
  };
}
