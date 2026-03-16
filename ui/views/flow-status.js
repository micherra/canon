/** Canon Flow Status View — Available flows and execution state */

import { STATUS_COLORS } from '../lib/theme.js';
import { loadJSON } from '../lib/data-loader.js';

export async function render(container) {
  container.innerHTML = `
    <div class="view-header">
      <h2>Flows</h2>
    </div>
    <div id="flow-list" class="flow-list"></div>
    <div id="flow-execution" class="flow-execution"></div>
  `;

  const listEl = container.querySelector('#flow-list');
  const execEl = container.querySelector('#flow-execution');

  // Try to load flow list from data file
  const flowData = await loadJSON('flow-list.json');

  if (flowData?.flows) {
    listEl.innerHTML = `
      <h3>Available Flows</h3>
      <div class="flow-cards">
        ${flowData.flows.map(f => `
          <div class="flow-card">
            <div class="flow-name">${f.name}</div>
            <div class="flow-desc">${f.description}</div>
            <div class="flow-meta">
              <span>${f.step_count} steps</span>
              ${f.has_loops ? '<span class="loop-badge">has loops</span>' : ''}
            </div>
          </div>
        `).join('')}
      </div>
    `;
  } else {
    listEl.innerHTML = `
      <h3>Available Flows</h3>
      <div class="flow-cards">
        <div class="flow-card">
          <div class="flow-name">ralph</div>
          <div class="flow-desc">Build-review-fix loop until CLEAN</div>
          <div class="flow-meta"><span>3 steps</span><span class="loop-badge">has loops</span></div>
        </div>
        <div class="flow-card">
          <div class="flow-name">quick-fix</div>
          <div class="flow-desc">Fast path for small fixes</div>
          <div class="flow-meta"><span>2 steps</span></div>
        </div>
        <div class="flow-card">
          <div class="flow-name">deep-build</div>
          <div class="flow-desc">Full research-to-review pipeline</div>
          <div class="flow-meta"><span>6 steps</span></div>
        </div>
        <div class="flow-card">
          <div class="flow-name">review-only</div>
          <div class="flow-desc">Review current changes</div>
          <div class="flow-meta"><span>1 step</span></div>
        </div>
        <div class="flow-card">
          <div class="flow-name">security-audit</div>
          <div class="flow-desc">Security scan + review</div>
          <div class="flow-meta"><span>2 steps</span></div>
        </div>
      </div>
      <p class="help-text">Run <code>/canon:flow &lt;name&gt; &lt;task&gt;</code> to execute a flow.</p>
    `;
  }

  // Try to load recent execution
  const execData = await loadJSON('flow-execution.json');
  if (execData) {
    execEl.innerHTML = `
      <h3>Last Execution: ${execData.flow_name}</h3>
      <div class="exec-status" style="color: ${STATUS_COLORS[execData.status === 'success' ? 'completed' : 'blocked']}">${execData.status}</div>
      <div class="exec-steps">
        ${(execData.step_results || []).map(s => `
          <div class="exec-step ${s.status}">
            <span class="step-id">${s.step_id}</span>
            <span class="step-status" style="color: ${STATUS_COLORS[s.status]}">${s.status}</span>
            ${s.verdict ? `<span class="step-verdict">${s.verdict}</span>` : ''}
          </div>
        `).join('')}
      </div>
      <div class="exec-meta">
        Steps: ${execData.steps_completed}/${execData.total_steps} |
        ${execData.started_at ? `Started: ${new Date(execData.started_at).toLocaleString()}` : ''}
      </div>
    `;
  }
}
