/**
 * MapRouter-specific attribution rules.
 * These exploit known log patterns and output invariants from the maprouter module.
 */

export const maprouterRules = [
  {
    id: 'MAPROUTER_NO_BEV',
    appliesTo: ['S2', 'S3'],
    evaluate(evidence) {
      const lines = evidence.stderrLines || [];
      if (lines.some(l => /not received latest BEV map data/i.test(l))) {
        return {
          severity: 'error',
          finding: 'BevMapData missing — GenerateRoute falls back to STANDBY',
          rootCauseHint: '/perception/static topic not recorded or empty',
          tags: ['algo_health', 'input_derived'],
          confidence: 0.95,
        };
      }
      return null;
    },
  },
  {
    id: 'MAPROUTER_NO_NEO_MAP',
    appliesTo: ['S2', 'S3'],
    evaluate(evidence) {
      const lines = evidence.stderrLines || [];
      if (lines.some(l => /not find nearest LD map data|has_ld_map is false/i.test(l))) {
        return {
          severity: 'error',
          finding: 'NeoMaps/LD map unavailable — route generation skipped',
          rootCauseHint: '/maprouter/maps topic missing or has_ld_map=false',
          tags: ['algo_health', 'input_derived'],
          confidence: 0.95,
        };
      }
      return null;
    },
  },
  {
    id: 'MAPROUTER_DIAG_INFO',
    appliesTo: ['S2'],
    evaluate(evidence) {
      const lines = evidence.stderrLines || [];
      const diagPatterns = [
        { pattern: /DiagInfo::NO_BEV_MAP|diag_info.*NO_BEV_MAP/i, msg: 'Diagnostic: NO_BEV_MAP' },
        { pattern: /DiagInfo::NO_NEO_MAP|diag_info.*NO_NEO_MAP/i, msg: 'Diagnostic: NO_NEO_MAP' },
        { pattern: /DiagInfo::NO_SD_ROUTE|diag_info.*NO_SD_ROUTE/i, msg: 'Diagnostic: NO_SD_ROUTE' },
        { pattern: /DiagInfo::CLEAR_CMD/i, msg: 'Diagnostic: CLEAR_CMD received' },
      ];
      const hits = [];
      for (const dp of diagPatterns) {
        if (lines.some(l => dp.pattern.test(l))) {
          hits.push(dp.msg);
        }
      }
      if (hits.length === 0) {
        return null;
      }
      return {
        severity: 'warn',
        finding: `MapRouter diagnostic: ${hits.join('; ')}`,
        tags: ['algo_health', 'diag_code'],
        confidence: 0.85,
      };
    },
  },
  {
    id: 'MAPROUTER_ALL_STANDBY',
    appliesTo: ['S2'],
    evaluate(evidence) {
      const lines = evidence.stderrLines || [];
      const standbyCount = lines.filter(l => /router_status.*STANDBY|ProcessStatus.*STANDBY/i.test(l)).length;
      const totalFrames = evidence.totalFrames || 0;
      if (totalFrames > 5 && standbyCount > totalFrames * 0.8) {
        return {
          severity: 'error',
          finding: `MapRouter stuck in STANDBY for ${standbyCount}/${totalFrames} frames — process() returning without real work`,
          rootCauseHint: 'Check config loaded + required inputs arrived',
          tags: ['algo_health'],
          confidence: 0.9,
        };
      }
      return null;
    },
  },
  {
    id: 'MAPROUTER_QUICK_RETURN',
    appliesTo: ['S2'],
    evaluate(evidence) {
      const times = evidence.frameTimes || [];
      if (times.length < 5) {
        return null;
      }
      const median = [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)];
      if (median < 0.1) {
        return {
          severity: 'warn',
          finding: `Suspiciously fast: median process time ${median.toFixed(3)}ms — likely short-circuiting without real computation`,
          rootCauseHint: 'Check config is loaded and all required inputs are registered with correct IDs',
          tags: ['algo_health', 'short_circuit'],
          confidence: 0.85,
        };
      }
      return null;
    },
  },
];
