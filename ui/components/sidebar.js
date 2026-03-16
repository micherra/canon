/** Canon Dashboard Sidebar Navigation */

const NAV_ITEMS = [
  { id: 'graph', label: 'Codebase Graph', icon: '◉' },
  { id: 'principles', label: 'Principles', icon: '◆' },
  { id: 'pr-review', label: 'PR Review', icon: '⎘' },
  { id: 'orchestration', label: 'Orchestration', icon: '⚙' },
  { id: 'flow-status', label: 'Flows', icon: '▶' },
];

export function createSidebar(container, onNavigate) {
  container.innerHTML = `
    <div class="sidebar-header">
      <h1 class="sidebar-title">Canon</h1>
      <span class="sidebar-subtitle">Dashboard</span>
    </div>
    <nav class="sidebar-nav">
      ${NAV_ITEMS.map(item => `
        <button class="nav-item" data-view="${item.id}">
          <span class="nav-icon">${item.icon}</span>
          <span class="nav-label">${item.label}</span>
        </button>
      `).join('')}
    </nav>
    <div class="sidebar-footer">
      <span class="sidebar-version">v2.0</span>
    </div>
  `;

  const buttons = container.querySelectorAll('.nav-item');
  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      buttons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      onNavigate(btn.dataset.view);
    });
  });

  // Activate first item by default
  if (buttons.length > 0) {
    buttons[0].classList.add('active');
  }
}
