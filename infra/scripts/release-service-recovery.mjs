import * as fs from 'node:fs';
import { refuse, SHA } from './release-service-boundary.mjs';

const BOOT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;

function processStat(text) {
  const close = text.lastIndexOf(') ');
  const pid = Number(text.slice(0, text.indexOf(' ')));
  const fields = text
    .slice(close + 2)
    .trim()
    .split(/\s+/u);
  if (
    close < 1 ||
    !Number.isSafeInteger(pid) ||
    pid < 1 ||
    fields.length < 20 ||
    !/^[A-Z]$/u.test(fields[0]) ||
    !/^[0-9]+$/u.test(fields[2]) ||
    !/^[0-9]+$/u.test(fields[19])
  )
    refuse('PROCESS_OBSERVATION_UNPROVED');
  return { pid, state: fields[0], group: Number(fields[2]), startTicks: fields[19] };
}

// FLAG: An absent parent PID alone does not prove that its detached children ended.
// Prove both Linux identity and the absence of a live process in its original group.
export function assertExecutorStopped(
  executor,
  { fileSystem = fs, proc = '/proc', signalProcessGroup = process.kill } = {},
) {
  if (
    !executor ||
    !Number.isSafeInteger(executor.pid) ||
    executor.pid < 1 ||
    !SHA.test(executor.sourceSha ?? '') ||
    !BOOT_ID.test(executor.bootId ?? '') ||
    !/^[0-9]{1,24}$/u.test(executor.startTicks ?? '')
  )
    refuse('EXECUTOR_IDENTITY_UNPROVED');
  const bootId = fileSystem.readFileSync(`${proc}/sys/kernel/random/boot_id`, 'utf8').trim();
  if (!BOOT_ID.test(bootId)) refuse('PROCESS_OBSERVATION_UNPROVED');
  if (bootId !== executor.bootId) return { bootId, previousBoot: true };
  const names = fileSystem.readdirSync(proc).filter((name) => /^[1-9][0-9]*$/u.test(name));
  if (names.length > 32768) refuse('PROCESS_OBSERVATION_UNPROVED');
  for (const name of names) {
    let raw;
    try {
      raw = fileSystem.readFileSync(`${proc}/${name}/stat`, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') continue;
      throw error;
    }
    const stat = processStat(raw);
    if (String(stat.pid) !== name) refuse('PROCESS_OBSERVATION_UNPROVED');
    if (
      (stat.pid === executor.pid && stat.startTicks === executor.startTicks) ||
      (stat.group === executor.pid && stat.state !== 'Z' && stat.state !== 'X')
    )
      refuse('EXECUTOR_STILL_PRESENT');
  }
  // FLAG: A proc directory snapshot can miss a child forked during the scan.
  // ESRCH from the kernel group lookup is the final positive absence proof.
  try {
    signalProcessGroup(-executor.pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return { bootId, previousBoot: false };
    refuse('PROCESS_OBSERVATION_UNPROVED');
  }
  refuse('EXECUTOR_STILL_PRESENT');
}
