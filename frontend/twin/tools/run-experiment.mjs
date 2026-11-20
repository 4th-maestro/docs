import os from 'node:os';
import path from 'node:path';
import { loadExperiment } from './experiment-input.mjs';
import { runEnergyPlusExperiment } from './experiment-energyplus.mjs';
import { run5R1CExperiment } from './experiment-5r1c.mjs';
import { findEnergyPlus } from './sim-runner.mjs';

try {
  const args = process.argv.slice(2);
  const selection = args.filter(arg => arg.startsWith('--engine='));
  const engine = selection[0]?.slice('--engine='.length) ?? 'energyplus';
  const positional = args.filter(arg => !arg.startsWith('--engine='));
  const [scenarioFile, registryFile, mode = 'compare', output = path.join(os.tmpdir(), 'maestro-hvac-experiments')] = positional;
  if (!scenarioFile || !registryFile || positional.length > 4 || selection.length > 1 ||
      !['validate','compare','always','occupancy'].includes(mode) || !['energyplus','5r1c','both'].includes(engine))
    throw new Error('사용법: node twin/tools/run-experiment.mjs <scenario.json> <registry.json> [validate|compare|always|occupancy] [출력 폴더] [--engine=energyplus|5r1c|both]');
  const input = loadExperiment(path.resolve(scenarioFile), path.resolve(registryFile));
  if (mode === 'validate') {
    console.log(JSON.stringify({ scenario_id:input.scenario.scenario_id, input_checksum:input.checksum,
      room_count:input.rooms.length, rows:input.rooms.length * input.conditions.values().next().value.length }, null, 2));
  } else {
    const runRC = controller => run5R1CExperiment(input, { controller, outDir:output });
    const executable = engine === '5r1c' ? null : findEnergyPlus();
    if (engine !== '5r1c' && !executable) throw new Error('EnergyPlus 24.2 설치 폴더를 ENERGYPLUS_DIR로 지정하세요.');
    const runEP = controller => runEnergyPlusExperiment(input, { controller, executable, outDir:output });
    const runMode = run => {
      if (mode !== 'compare') return run(mode);
      const baseline = run('always'), candidate = run('occupancy');
      return { baseline, candidate,
        hvac_estimated_saved_Wh:baseline.summary.hvac_estimated_energy_Wh - candidate.summary.hvac_estimated_energy_Wh };
    };
    const result = engine === 'both' ? { energyplus:runMode(runEP), '5r1c':runMode(runRC) }
      : runMode(engine === '5r1c' ? runRC : runEP);
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
