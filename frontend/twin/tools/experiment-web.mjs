import os from 'node:os';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadExperiment } from './experiment-input.mjs';
import { runEnergyPlusExperiment } from './experiment-energyplus.mjs';
import { run5R1CExperiment } from './experiment-5r1c.mjs';
import { findEnergyPlus, ROOT } from './sim-runner.mjs';

function syntheticBusanWeather() {
  const header = [
    'LOCATION,Synthetic Busan,,KOR,Synthetic,000000,35.10,129.03,9,10',
    'DESIGN CONDITIONS,0',
    'TYPICAL/EXTREME PERIODS,0',
    'GROUND TEMPERATURES,0',
    'HOLIDAYS/DAYLIGHT SAVINGS,No,0,0,0',
    'COMMENTS 1,Synthetic data for a local demonstration',
    'COMMENTS 2,Temperatures and solar radiation are illustrative',
    'DATA PERIODS,1,1,Data,Thursday,1/1,12/31',
  ];
  for (let day = 0; day < 365; day++) {
    const date = new Date(Date.UTC(2026, 0, day + 1));
    for (let hour = 1; hour <= 24; hour++) {
      const temp = +(29 + 4 * Math.cos((hour - 15) * Math.PI / 12)).toFixed(1);
      const sun = Math.max(0, Math.round(650 * Math.sin((hour - 6) * Math.PI / 13)));
      header.push([2026,date.getUTCMonth()+1,date.getUTCDate(),hour,60,'?9',temp,temp-8,60,101325,
        0,0,350,sun,sun,0,0,0,0,0,180,2,3,3,20,1000,9,999999999,15,0.1,0,0,0.2,0,0].join(','));
    }
  }
  return header.join('\n') + '\n';
}

try {
  const engine = process.argv[2];
  if (!['5r1c','energyplus','both'].includes(engine)) throw new Error('지원하지 않는 실험 엔진입니다.');
  const example = path.join(ROOT, 'experiments', 'example');
  const input = loadExperiment(path.join(example, 'scenario.json'), path.join(example, 'registry.json'), {
    weatherOverride:syntheticBusanWeather(),
    weatherSource:'부산 위치의 합성 기상',
  });
  const executable = engine === '5r1c' ? null : findEnergyPlus();
  if (engine !== '5r1c' && !executable) throw new Error('EnergyPlus 24.2를 찾을 수 없습니다. 5R1C를 선택할 수 있습니다.');
  const outDir = path.join(os.tmpdir(), 'maestro-hvac-experiments');
  const read = run => {
    const { summary, rows } = JSON.parse(readFileSync(run.file, 'utf8'));
    return { summary, rows };
  };
  const report = run => ({ baseline:read(run('always')), candidate:read(run('occupancy')) });
  const results = {};
  if (engine !== 'energyplus') results['5r1c'] = report(controller => run5R1CExperiment(input, { controller, outDir }));
  if (engine !== '5r1c') results.energyplus = report(controller => runEnergyPlusExperiment(input, { controller, executable, outDir }));
  const room = input.building.floors.flatMap(floor => floor.rooms).find(r => r.id === input.rooms[0]);
  console.log(JSON.stringify({ room:room?.name ?? input.rooms[0], start:input.scenario.start_time,
    end:input.scenario.end_time, weather:input.scenario.provenance.weather, results }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
