/**
 * AttributionSession — shared context for one Run Test attribution session.
 *
 * Holds references to the module config, mcap data, WS connection to the
 * harness, and the accumulated evidence/findings from each stage.
 *
 * Designed to be passed as `ctx` to every stage's `run(ctx)` function.
 */

const BACKEND_BASE = 'http://localhost:8765';

export function createSession({ nodeId, topology, summary, runtime, soPath, className, configPaths, inputTopics, outputTopics, outputDataNames, hz, msgDataCache, startTimeNs, selectedExecutors }) {
  return {
    nodeId,
    topology,
    summary,
    runtime: runtime || 'unknown',
    soPath: soPath || '',
    className: className || '',
    configPaths: configPaths || [],
    inputTopics: inputTopics || [],
    outputTopics: outputTopics || [],
    outputDataNames: outputDataNames || [],
    hz: hz || 20,
    backendBase: BACKEND_BASE,
    msgDataCache: msgDataCache || null,
    startTimeNs: startTimeNs || null,
    selectedExecutors: selectedExecutors || [],

    ws: null,
    harnessPid: null,

    evidence: {},
    findings: [],
    stageResults: {},
    stderrLines: [],

    setEvidence(stageId, key, value) {
      if (!this.evidence[stageId]) {
        this.evidence[stageId] = {};
      }
      this.evidence[stageId][key] = value;
    },

    getEvidence(stageId, key) {
      return this.evidence[stageId]?.[key];
    },

    addFinding(finding) {
      this.findings.push({
        ...finding,
        time: new Date().toISOString(),
      });
    },

    setStageResult(stageId, result) {
      this.stageResults[stageId] = result;
    },

    getSlug() {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      return `${this.nodeId}-${ts}`;
    },
  };
}
