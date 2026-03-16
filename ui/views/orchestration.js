/** Canon Orchestration View — Pipeline + loop visualization */

import { STATUS_COLORS, VERDICT_COLORS } from '../lib/theme.js';
import { loadOrchestrationData } from '../lib/data-loader.js';

const PIPELINE_PHASES = [
  'research', 'architect', 'plan', 'implement', 'test', 'security', 'review'
];

let refreshInterval = null;

export async function render(container) {
  container.innerHTML = `
    <div class="view-header">
      <h2>Orchestration</h2>
      <div class="orch-controls">
        <label class="chip">
          <input type="checkbox" id="live-toggle"> Live (2s refresh)
        </label>
      </div>
    </div>
    <div id="pipeline-view" class="pipeline-view"></div>
    <div id="ralph-loop-view" class="ralph-loop-view"></div>
    <div id="event-timeline" class="event-timeline"></div>
  `;

  const liveToggle = container.querySelector('#live-toggle');
  liveToggle.addEventListener('change', () => {
    if (liveToggle.checked) {
      refreshInterval = setInterval(() => loadAndRender(container), 2000);
    } else {
      clearInterval(refreshInterval);
      refreshInterval = null;
    }
  });

  await loadAndRender(container);
}

async function loadAndRender(container) {
  const data = await loadOrchestrationData();
  const pipeline = container.querySelector('#pipeline-view');
  const loopView = container.querySelector('#ralph-loop-view');
  const timeline = container.querySelector('#event-timeline');

  if (!data) {
    pipeline.innerHTML = '<p class="empty-state">No orchestration data. Run <code>/canon:ralph</code> or <code>/canon:flow</code> to generate.</p>';
    return;
  }

  // Pipeline visualization
  if (data.pipeline) {
    pipeline.innerHTML = `
      <div class="pipeline-stages">
        ${PIPELINE_PHASES.map(phase => {
          const stageData = data.pipeline.find(s => s.phase === phase);
          const status = stageData?.status || 'pending';
          const color = STATUS_COLORS[status];
          return `
            <div class="pipeline-stage" style="--stage-color: ${color}">
              <div class="stage-indicator ${status}"></div>
              <div class="stage-label">${phase}</div>
              ${stageData?.agents ? `
                <div class="stage-agents">
                  ${stageData.agents.map(a => `
                    <div class="agent-chip ${a.status}">
                      ${a.name.replace('canon-', '')}
                    </div>
                  `).join('')}
                </div>
              ` : ''}
            </div>
          `;
        }).join('<div class="pipeline-arrow">→</div>')}
      </div>
    `;
  }

  // Ralph loop visualization
  if (data.ralph_loop) {
    const loop = data.ralph_loop;
    loopView.innerHTML = `
      <h3>Ralph Loop — Iteration ${loop.current_iteration}/${loop.max_iterations}</h3>
      <div class="loop-iterations">
        ${(loop.history || []).map(h => `
          <div class="loop-iter">
            <div class="iter-number">#${h.iteration}</div>
            <div class="iter-verdict" style="color: ${VERDICT_COLORS[h.verdict] || '#7f8c8d'}">${h.verdict}</div>
            <div class="iter-stats">${h.violations_count} violations, ${h.violations_fixed} fixed</div>
          </div>
        `).join('')}
      </div>
    `;
  } else {
    loopView.innerHTML = '';
  }

  // Event timeline
  if (data.events?.length > 0) {
    const recent = data.events.slice(-20).reverse();
    timeline.innerHTML = `
      <h3>Event Timeline</h3>
      <div class="timeline-list">
        ${recent.map(e => `
          <div class="timeline-event">
            <span class="event-time">${new Date(e.timestamp).toLocaleTimeString()}</span>
            <span class="event-type">${e.event_type}</span>
            ${e.agent_name ? `<span class="event-agent">${e.agent_name}</span>` : ''}
            ${e.phase ? `<span class="event-phase">${e.phase}</span>` : ''}
            ${e.status ? `<span class="event-status ${e.status}">${e.status}</span>` : ''}
          </div>
        `).join('')}
      </div>
    `;
  }
}

export function cleanup() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}
