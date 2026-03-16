/** Canon Codebase Graph View — D3.js force-directed graph */

import { LAYER_COLORS, VERDICT_COLORS } from '../lib/theme.js';
import { loadGraphData } from '../lib/data-loader.js';
import { createLayerFilters, createSearchFilter } from '../components/filters.js';

export async function render(container) {
  container.innerHTML = `
    <div class="view-header">
      <h2>Codebase Graph</h2>
      <div id="graph-filters" class="filter-bar"></div>
      <div id="graph-search" class="filter-bar"></div>
    </div>
    <div class="graph-layout">
      <div id="graph-canvas" class="graph-canvas"></div>
      <div id="graph-detail" class="detail-panel">
        <p class="detail-placeholder">Click a node to see details</p>
      </div>
    </div>
  `;

  const data = await loadGraphData();
  if (!data) {
    container.querySelector('.graph-canvas').innerHTML =
      '<p class="empty-state">No graph data. Run <code>/canon:graph</code> to generate.</p>';
    return;
  }

  const canvas = container.querySelector('#graph-canvas');
  const detail = container.querySelector('#graph-detail');
  let activeLayers = [...new Set(data.nodes.map(n => n.layer))];

  // Filters
  createLayerFilters(
    container.querySelector('#graph-filters'),
    activeLayers,
    (layers) => { activeLayers = layers; renderGraph(); }
  );
  createSearchFilter(
    container.querySelector('#graph-search'),
    'Search files...',
    (q) => { searchQuery = q; renderGraph(); }
  );

  let searchQuery = '';

  function renderGraph() {
    const filtered = data.nodes.filter(n =>
      activeLayers.includes(n.layer) &&
      (!searchQuery || n.id.toLowerCase().includes(searchQuery.toLowerCase()))
    );
    const filteredIds = new Set(filtered.map(n => n.id));
    const filteredEdges = data.edges.filter(e =>
      filteredIds.has(e.source) && filteredIds.has(e.target)
    );

    renderD3Graph(canvas, detail, filtered, filteredEdges, data.hotspots);
  }

  renderGraph();
}

function renderD3Graph(canvas, detail, nodes, edges, hotspots) {
  // Check if D3 is loaded
  if (typeof d3 === 'undefined') {
    canvas.innerHTML = `
      <div class="graph-fallback">
        <h3>Graph Data Summary</h3>
        <p>${nodes.length} files, ${edges.length} dependencies</p>
        <table class="data-table">
          <thead><tr><th>File</th><th>Layer</th><th>Violations</th></tr></thead>
          <tbody>
            ${nodes.slice(0, 50).map(n => `
              <tr class="${n.violation_count > 0 ? 'violation-row' : ''}">
                <td>${n.id}</td>
                <td><span class="layer-dot" style="background:${n.color}"></span>${n.layer}</td>
                <td>${n.violation_count || '-'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        ${nodes.length > 50 ? `<p class="truncated">...and ${nodes.length - 50} more</p>` : ''}
      </div>
    `;
    return;
  }

  // D3 force-directed graph
  canvas.innerHTML = '';
  const width = canvas.clientWidth || 800;
  const height = canvas.clientHeight || 600;

  const svg = d3.select(canvas).append('svg')
    .attr('width', width)
    .attr('height', height)
    .attr('viewBox', [0, 0, width, height]);

  const g = svg.append('g');

  // Zoom
  svg.call(d3.zoom().on('zoom', (event) => {
    g.attr('transform', event.transform);
  }));

  const simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(edges).id(d => d.id).distance(80))
    .force('charge', d3.forceManyBody().strength(-200))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide().radius(20));

  const link = g.selectAll('.link')
    .data(edges)
    .join('line')
    .attr('class', 'link')
    .attr('stroke', '#555')
    .attr('stroke-opacity', 0.3);

  const node = g.selectAll('.node')
    .data(nodes)
    .join('circle')
    .attr('class', 'node')
    .attr('r', d => 6 + Math.min(d.violation_count * 2, 14))
    .attr('fill', d => d.color)
    .attr('stroke', d => d.violation_count > 0 ? VERDICT_COLORS.BLOCKING : '#333')
    .attr('stroke-width', d => d.violation_count > 0 ? 2 : 1)
    .on('click', (event, d) => showDetail(detail, d))
    .call(d3.drag()
      .on('start', (event, d) => { if (!event.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
      .on('end', (event, d) => { if (!event.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; })
    );

  node.append('title').text(d => d.id);

  simulation.on('tick', () => {
    link.attr('x1', d => d.source.x).attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    node.attr('cx', d => d.x).attr('cy', d => d.y);
  });
}

function showDetail(panel, node) {
  panel.innerHTML = `
    <h3>${node.id}</h3>
    <div class="detail-field">
      <label>Layer</label>
      <span class="layer-dot" style="background:${node.color}"></span> ${node.layer}
    </div>
    <div class="detail-field">
      <label>Violations</label>
      <span class="${node.violation_count > 0 ? 'text-danger' : ''}">${node.violation_count}</span>
    </div>
    <div class="detail-field">
      <label>Last Verdict</label>
      ${node.last_verdict
        ? `<span class="verdict-badge" style="background:${VERDICT_COLORS[node.last_verdict] || '#7f8c8d'}">${node.last_verdict}</span>`
        : '<span class="text-muted">No review</span>'}
    </div>
    <div class="detail-field">
      <label>Changed</label>
      ${node.changed ? '<span class="text-info">Yes</span>' : '<span class="text-muted">No</span>'}
    </div>
  `;
}
