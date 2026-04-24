/**
 * Rule engine for attribution findings.
 *
 * Dispatches to common rules + module-specific rules based on nodeId.
 * Returns an array of findings: { id, severity, finding, tags, confidence, ... }
 */

import { commonRules } from './common.js';
import { maprouterRules } from './maprouter.js';

const MODULE_RULES = {
  map_router: maprouterRules,
};

export function evaluateRules(stageId, evidence, ctx) {
  const findings = [];

  const allRules = [...commonRules];
  const moduleRules = MODULE_RULES[ctx.nodeId] || [];
  allRules.push(...moduleRules);

  for (const rule of allRules) {
    if (!rule.appliesTo.includes(stageId)) {
      continue;
    }
    try {
      const finding = rule.evaluate(evidence, ctx);
      if (finding) {
        findings.push({
          ruleId: rule.id,
          stageId,
          ...finding,
        });
      }
    } catch (err) {
      console.warn(`Rule ${rule.id} threw:`, err);
    }
  }

  return findings;
}

const CAUSAL_TEMPLATES = [
  {
    ifTags: ['upstream_gap'],
    andIfTags: ['output_diverge'],
    infer: {
      primary: 'upstream_gap',
      message: 'Output divergence is likely caused by missing upstream input',
      reduceWeight: ['output_diverge'],
    },
  },
  {
    ifTags: ['config_fail'],
    infer: {
      primary: 'config_fail',
      shortCircuit: true,
      message: 'Config failed to load — all downstream findings are unreliable',
    },
  },
  {
    ifTags: ['load_fail'],
    infer: {
      primary: 'load_fail',
      shortCircuit: true,
      message: 'Module failed to load — no meaningful analysis possible',
    },
  },
  {
    ifTags: ['short_circuit'],
    andIfTags: ['output_empty'],
    infer: {
      primary: 'short_circuit',
      message: 'Process is short-circuiting, causing empty outputs',
      reduceWeight: ['output_empty'],
    },
  },
];

export function inferRootCauses(findings) {
  const tagSet = new Set();
  for (const f of findings) {
    for (const t of (f.tags || [])) {
      tagSet.add(t);
    }
  }

  const causes = [];
  const reducedTags = new Set();

  for (const tmpl of CAUSAL_TEMPLATES) {
    const ifMatch = tmpl.ifTags.every(t => tagSet.has(t));
    const andIfMatch = !tmpl.andIfTags || tmpl.andIfTags.every(t => tagSet.has(t));

    if (ifMatch && andIfMatch) {
      causes.push({
        primary: tmpl.infer.primary,
        message: tmpl.infer.message,
        shortCircuit: tmpl.infer.shortCircuit || false,
      });
      for (const rt of (tmpl.infer.reduceWeight || [])) {
        reducedTags.add(rt);
      }
    }
  }

  const enrichedFindings = findings.map(f => {
    const reduced = (f.tags || []).some(t => reducedTags.has(t));
    return { ...f, weightReduced: reduced };
  });

  return { causes, findings: enrichedFindings };
}
