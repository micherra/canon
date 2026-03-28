# Frontend Domain

Pay attention to these concerns when working in this domain.

- **Component composition**: Keep components small and single-purpose; compose them rather than growing monolithic components.
- **Prop design**: Pass only what the component needs; avoid wide prop interfaces that couple parent to implementation details.
- **Accessibility**: Use semantic HTML elements, add ARIA labels where needed, and ensure keyboard navigation works for all interactive elements.
- **Responsive layout**: Design for the smallest viewport first; use relative units and avoid fixed pixel widths for layout containers.
- **State management**: Keep state as local as possible; lift to shared store only when multiple components genuinely need it.
- **Event handling**: Debounce high-frequency events (scroll, resize, input); clean up listeners in teardown/destroy lifecycle hooks.
- **Performance**: Avoid unnecessary re-renders; lazy-load heavy components and assets; keep bundle size in check by auditing imports.
- **Browser compatibility**: Verify that any Web APIs used are available in the project's supported browser targets.
