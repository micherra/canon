/** Canon Principle Explorer View */

import { SEVERITY_COLORS } from '../lib/theme.js';
import { loadPrinciplesData } from '../lib/data-loader.js';
import { createSearchFilter, createSeverityBadge } from '../components/filters.js';

export async function render(container) {
  container.innerHTML = `
    <div class="view-header">
      <h2>Principle Explorer</h2>
      <div id="principle-search" class="filter-bar"></div>
      <div class="filter-bar">
        <label class="chip"><input type="checkbox" checked data-sev="rule"> Rules</label>
        <label class="chip"><input type="checkbox" checked data-sev="strong-opinion"> Strong Opinions</label>
        <label class="chip"><input type="checkbox" checked data-sev="convention"> Conventions</label>
      </div>
    </div>
    <div id="principle-list" class="principle-list"></div>
    <div id="try-it" class="try-it-panel">
      <h3>Try It</h3>
      <textarea id="try-code" placeholder="Paste code here to see which principles apply..." rows="6"></textarea>
      <button id="try-btn" class="btn">Check Principles</button>
      <div id="try-result"></div>
    </div>
  `;

  const data = await loadPrinciplesData();
  const list = container.querySelector('#principle-list');

  if (!data || !data.principles) {
    list.innerHTML = '<p class="empty-state">No principles data. Run <code>/canon:dashboard</code> to generate.</p>';
    return;
  }

  let searchQuery = '';
  let activeSeverities = new Set(['rule', 'strong-opinion', 'convention']);

  createSearchFilter(
    container.querySelector('#principle-search'),
    'Search principles...',
    (q) => { searchQuery = q; renderList(); }
  );

  container.querySelectorAll('[data-sev]').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) activeSeverities.add(cb.dataset.sev);
      else activeSeverities.delete(cb.dataset.sev);
      renderList();
    });
  });

  function renderList() {
    const filtered = data.principles.filter(p =>
      activeSeverities.has(p.severity) &&
      (!searchQuery || p.id.includes(searchQuery) || p.title.toLowerCase().includes(searchQuery.toLowerCase()))
    );

    list.innerHTML = filtered.map(p => `
      <div class="principle-card" data-id="${p.id}">
        <div class="principle-header">
          ${createSeverityBadge(p.severity)}
          <strong>${p.id}</strong>
          <span class="principle-title">${p.title}</span>
        </div>
        <div class="principle-meta">
          ${p.tags ? p.tags.map(t => `<span class="tag">${t}</span>`).join('') : ''}
          ${p.compliance_rate !== undefined ? `<span class="compliance">${p.compliance_rate}% compliant</span>` : ''}
        </div>
        <div class="principle-body collapsed" id="body-${p.id}">
          ${p.body || '<em>No body available</em>'}
        </div>
      </div>
    `).join('');

    // Toggle body on click
    list.querySelectorAll('.principle-card').forEach(card => {
      card.addEventListener('click', () => {
        const body = card.querySelector('.principle-body');
        body.classList.toggle('collapsed');
      });
    });
  }

  renderList();
}
