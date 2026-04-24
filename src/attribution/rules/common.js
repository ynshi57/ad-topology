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
