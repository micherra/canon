/** Canon Dashboard Shared Filter Controls */

import { LAYER_COLORS, SEVERITY_COLORS, VERDICT_COLORS } from '../lib/theme.js';

export function createLayerFilters(container, layers, onChange) {
  container.innerHTML = `
    <div class="filter-group">
      <label class="filter-label">Layers</label>
      <div class="filter-chips">
        ${layers.map(layer => `
          <label class="chip" style="--chip-color: ${LAYER_COLORS[layer] || LAYER_COLORS.unknown}">
            <input type="checkbox" checked data-layer="${layer}">
            <span class="chip-dot" style="background: ${LAYER_COLORS[layer] || LAYER_COLORS.unknown}"></span>
            ${layer}
          </label>
        `).join('')}
      </div>
    </div>
  `;

  container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const active = Array.from(container.querySelectorAll('input:checked'))
        .map(el => el.dataset.layer);
      onChange(active);
    });
  });
}

export function createSearchFilter(container, placeholder, onSearch) {
  container.innerHTML = `
    <div class="filter-group">
      <input type="text" class="search-input" placeholder="${placeholder}">
    </div>
  `;

  const input = container.querySelector('.search-input');
  let timeout;
  input.addEventListener('input', () => {
    clearTimeout(timeout);
    timeout = setTimeout(() => onSearch(input.value), 200);
  });
}

export function createVerdictBadge(verdict) {
  const color = VERDICT_COLORS[verdict] || '#7f8c8d';
  return `<span class="verdict-badge" style="background: ${color}">${verdict}</span>`;
}

export function createSeverityBadge(severity) {
  const color = SEVERITY_COLORS[severity] || '#7f8c8d';
  return `<span class="severity-badge" style="background: ${color}">${severity}</span>`;
}
