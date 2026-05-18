/**
 * Render predicted vs actual function impact without claiming unknown actual
 * states are off.
 */

function esc(s) {
  const d = document.createElement('span');
  d.textContent = String(s ?? '');
  return d.innerHTML;
}

export function renderImpactTable(impact = {}) {
  const entries = Object.entries(impact || {});
  if (entries.length === 0) {
    return '<div class="vqa-empty">No function impact output.</div>';
  }
  return `
    <table class="vqa-impact-table">
      <thead>
        <tr>
          <th>Function</th>
          <th>Predicted</th>
          <th>Actual</th>
          <th>Evidence</th>
        </tr>
      </thead>
      <tbody>
        ${entries.map(([name, item]) => {
          const actual = item.actual || 'unknown';
          const actualCls = actual === 'unknown' ? 'unknown' : actual;
          return `
            <tr>
              <td>${esc(name)}</td>
              <td><span class="vqa-impact-chip ${esc(item.predicted || 'unknown')}">${esc(item.predicted || 'unknown')}</span></td>
              <td><span class="vqa-impact-chip actual-${esc(actualCls)}">${esc(actual)}</span></td>
              <td>
                <div>${esc(item.evidence_type || 'unknown')}</div>
                <div class="vqa-impact-basis">${esc((item.basis || []).join('; '))}</div>
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}
