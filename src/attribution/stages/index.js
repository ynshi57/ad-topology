import s1Load from './s1-load.js';
import s2Replay from './s2-replay.js';
import s3InputHealth from './s3-input-health.js';
import s4OutputDiff from './s4-output-diff.js';
import s5PerfSnapshot from './s5-perf-snapshot.js';
import s6Report from './s6-report.js';

export { s1Load, s2Replay, s3InputHealth, s4OutputDiff, s5PerfSnapshot, s6Report };

export const ALL_STAGES = [s1Load, s2Replay, s3InputHealth, s4OutputDiff, s5PerfSnapshot, s6Report];
