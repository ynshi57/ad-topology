/**
 * Common attribution rules — applicable to all modules.
 * Each rule: { id, appliesTo: [stageIds], evaluate(evidence, ctx) → finding | null }
 */

export const commonRules = [
  {
    id: 'SO_LOAD_FAIL',
    appliesTo: ['S1'],
    evaluate(evidence) {
      if (evidence.loadError) {
        return { severity: 'error', finding: `Module load failed: ${evidence.loadError}`, tags: ['load_fail'], confidence: 1.0 };
      }
      return null;
    },
  },
  {
    id: 'CONFIG_LOAD_FAIL',
    appliesTo: ['S1'],
    evaluate(evidence) {
      const stderr = evidence.stderrLines || [];
      const cfgFail = stderr.find(l => /config.*(?:YAML exception|bad file|failed to load)/i.test(l));
      if (cfgFail) {
        return { severity: 'error', finding: `Config load issue: ${cfgFail}`, tags: ['config_fail'], confidence: 0.95 };
      }
      return null;
    },
  },
  {
    id: 'REQ_INPUT_MISSING',
    appliesTo: ['S3'],
    evaluate(evidence) {
      const missing = evidence.missingRequired || [];
      if (missing.length === 0) {
        return null;
      }
      return {
        severity: 'warn',
        finding: `Required input missing: ${missing.join(', ')}`,
        rootCauseHint: 'upstream not recorded/publishing',
        tags: ['upstream_gap'],
        confidence: 0.9,
      };
    },
  },
  {
    id: 'INPUT_FREQ_DEGRADE',
    appliesTo: ['S3'],
    evaluate(evidence) {
      const degraded = [];
      for (const [topic, stats] of Object.entries(evidence.topicStats || {})) {
        if (stats.designHz > 0 && stats.actualHz > 0 && stats.actualHz < stats.designHz * 0.5) {
          degraded.push(`${topic}: ${stats.actualHz.toFixed(1)}Hz / ${stats.designHz}Hz expected`);
        }
      }
      if (degraded.length === 0) {
        return null;
      }
      return {
        severity: 'warn',
        finding: `Input frequency degraded: ${degraded.join('; ')}`,
        tags: ['freq_degrade'],
        confidence: 0.8,
      };
    },
  },
  {
    id: 'PROCESS_FAIL_RATE',
    appliesTo: ['S2'],
    evaluate(evidence) {
      const total = evidence.totalFrames || 0;
      const ok = evidence.okFrames || 0;
      if (total === 0) {
        return null;
      }
      const rate = ok / total;
      if (rate >= 0.8) {
        return null;
      }
      return {
        severity: rate < 0.5 ? 'error' : 'warn',
        finding: `Process success rate: ${(rate * 100).toFixed(1)}% (${ok}/${total})`,
        tags: ['process_fail'],
        confidence: 0.95,
      };
    },
  },
  {
    id: 'L1_CRASH_RATE',
    appliesTo: ['S2'],
    evaluate(evidence) {
      const total = evidence.totalFrames || 0;
      const l1 = evidence.l1Frames ?? total;
      if (total === 0 || l1 === total) {
        return null;
      }
      const crashCount = total - l1;
      return {
        severity: 'error',
        finding: `L1 crash: ${crashCount}/${total} frames crashed (SIGSEGV/exception)`,
        tags: ['l1_crash'],
        confidence: 1.0,
      };
    },
  },
  {
    id: 'L2_OUTPUT_THRESHOLD',
    appliesTo: ['S2'],
    evaluate(evidence, ctx) {
      const total = evidence.totalFrames || 0;
      const l2 = evidence.l2Frames || 0;
      const avgBytes = evidence.avgOutputBytes || 0;
      if (total === 0) {
        return null;
      }
      if (ctx?.nodeId === 'fault_manager') {
        const outputs = evidence.allOutputMetrics || [];
        const hasFaultProcess = outputs.some(o =>
          o.name === 'fault_process_data' && o.non_empty && (o.data_size || 0) > 0
        );
        if (hasFaultProcess) {
          return null;
        }
      }
      const rate = l2 / total;
      if (rate >= 0.8) {
        return null;
      }
      return {
        severity: rate < 0.3 ? 'error' : 'warn',
        finding: `L2 effective rate: ${(rate * 100).toFixed(1)}% (${l2}/${total}), avg output ${Math.round(avgBytes)}B — executor produces trivial/empty output`,
        rootCauseHint: 'Missing upstream data (BevMap, StateMachine) or executor in STANDBY mode',
        tags: ['l2_output_threshold'],
        confidence: 0.9,
      };
    },
  },
  {
    id: 'L2_STDERR_ERROR',
    appliesTo: ['S2'],
    evaluate(evidence, ctx) {
      let errorLines = evidence.stderrErrorLines || [];
      if (ctx?.nodeId === 'fault_manager') {
        errorLines = errorLines.filter(line =>
          !line.includes('[FaultInput]') &&
          !line.includes('[FaultPublish]') &&
          !line.includes('[FaultConfirm]') &&
          !line.includes('[FaultArbitrate]')
        );
      }
      if (errorLines.length === 0) {
        return null;
      }
      const sample = errorLines.slice(0, 3).map(l => l.substring(0, 120));
      return {
        severity: errorLines.length > 10 ? 'error' : 'warn',
        finding: `${errorLines.length} ERROR/FATAL lines in stderr: ${sample.join('; ')}${errorLines.length > 3 ? ' ...' : ''}`,
        tags: ['l2_stderr_error'],
        confidence: 0.85,
      };
    },
  },
  {
    id: 'L2_VPM_RATE',
    appliesTo: ['S2'],
    evaluate(evidence, ctx) {
      if (ctx?.nodeId === 'fault_manager') {
        return null;
      }
      const vpmErrors = evidence.vpmErrorLines || [];
      const total = evidence.totalFrames || 0;
      if (total === 0 || vpmErrors.length === 0) {
        return null;
      }
      const failRate = vpmErrors.length / total;
      if (failRate < 0.1) {
        return null;
      }
      return {
        severity: failRate > 0.5 ? 'error' : 'warn',
        finding: `VPM failure rate: ${(failRate * 100).toFixed(1)}% (${vpmErrors.length} errors / ${total} frames)`,
        rootCauseHint: 'VPM not receiving enough DR/GNSS/CAN data for interpolation',
        tags: ['l2_vpm_rate'],
        confidence: 0.9,
      };
    },
  },
  {
    id: 'LATENCY_SPIKE',
    appliesTo: ['S2'],
    evaluate(evidence) {
      const times = evidence.frameTimes || [];
      if (times.length < 5) {
        return null;
      }
      const sorted = [...times].sort((a, b) => a - b);
      const p50 = sorted[Math.floor(sorted.length * 0.5)];
      const p99 = sorted[Math.floor(sorted.length * 0.99)];
      if (p50 > 0 && p99 > p50 * 10) {
        return {
          severity: 'warn',
          finding: `Latency spike: p50=${p50.toFixed(2)}ms, p99=${p99.toFixed(2)}ms (${(p99 / p50).toFixed(0)}x)`,
          tags: ['latency_spike'],
          confidence: 0.85,
        };
      }
      return null;
    },
  },
  {
    id: 'OUTPUT_SIZE_ZERO',
    appliesTo: ['S4'],
    evaluate(evidence) {
      const zeroOutputs = evidence.zeroOutputChannels || [];
      if (zeroOutputs.length === 0) {
        return null;
      }
      return {
        severity: 'error',
        finding: `Output channels always empty: ${zeroOutputs.join(', ')}`,
        tags: ['output_empty'],
        confidence: 0.9,
      };
    },
  },
  {
    id: 'OUTPUT_SIZE_DIVERGE',
    appliesTo: ['S4'],
    evaluate(evidence) {
      const diverged = evidence.divergedOutputs || [];
      if (diverged.length === 0) {
        return null;
      }
      return {
        severity: 'warn',
        finding: `Output size divergence: ${diverged.map(d => `${d.name}: replay avg ${d.replayAvg}B vs recorded avg ${d.recordedAvg}B`).join('; ')}`,
        tags: ['output_diverge'],
        confidence: 0.7,
      };
    },
  },
  {
    id: 'OUTPUT_TRIVIAL',
    appliesTo: ['S4'],
    evaluate(evidence) {
      const trivial = evidence.trivialOutputChannels || [];
      if (trivial.length === 0) {
        return null;
      }
      return {
        severity: 'warn',
        finding: `Output channels with trivially small data: ${trivial.map(t => `${t.name}: avg ${t.avgSize}B`).join(', ')}`,
        rootCauseHint: 'Executor producing STANDBY/empty protobuf output despite returning kProcessOk',
        tags: ['output_trivial'],
        confidence: 0.85,
      };
    },
  },
  {
    id: 'PERF_HOTSPOT',
    appliesTo: ['S5'],
    evaluate(evidence) {
      const hotspots = evidence.hotspots || [];
      const hot = hotspots.filter(h => h.pct > 30);
      if (hot.length === 0) {
        return null;
      }
      return {
        severity: 'warn',
        finding: `Perf hotspot: ${hot.map(h => `${h.func} ${h.pct.toFixed(1)}%`).join(', ')}`,
        tags: ['perf_hotspot'],
        confidence: 0.8,
      };
    },
  },
  {
    id: 'PERF_UNKNOWN_SYMBOLS',
    appliesTo: ['S5'],
    evaluate(evidence) {
      const unknownPct = evidence.unknownSymbolPct || 0;
      if (unknownPct < 20) {
        return null;
      }
      return {
        severity: 'warn',
        finding: `${unknownPct.toFixed(0)}% of perf samples have [unknown] symbols — check DWARF/strip status`,
        tags: ['perf_symbols'],
        confidence: 0.7,
      };
    },
  },
];
