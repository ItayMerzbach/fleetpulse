import { useEffect } from 'react';
import type { FleetPulse } from '../../app/createFleetPulse';
import type { UiState } from '../../stores/stores';
import { applyFilters, type TruckRow } from './useFleetView';

export const SHORTCUTS: Array<[string, string]> = [
  ['j / ↓', 'Next truck'],
  ['k / ↑', 'Previous truck'],
  ['n', 'New route for selected truck (focus destination)'],
  ['/', 'Search trucks'],
  ['a', 'Acknowledge all alerts'],
  ['1 – 5', 'Routes · Activity · Alerts · Anomalies · Observability'],
  ['Esc', 'Close dialog / deselect truck'],
  ['?', 'Show this help'],
];

const PANELS: UiState['panel'][] = ['routes', 'activity', 'alerts', 'anomalies', 'observability'];

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

export function useKeyboardShortcuts(app: FleetPulse, getRows: () => TruckRow[]) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector('.modal')) return; // dialogs own the keyboard
      if (isTyping(e.target)) {
        if (e.key === 'Escape') (e.target as HTMLElement).blur();
        return;
      }
      const ui = app.stores.ui.getState();
      const rows = applyFilters(getRows(), ui.filters);
      const idx = rows.findIndex((r) => r.id === ui.selectedTruckId);

      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          if (rows.length) app.selectTruck(rows[(idx + 1) % rows.length].id);
          break;
        case 'k':
        case 'ArrowUp':
          if (rows.length) app.selectTruck(rows[(idx - 1 + rows.length) % rows.length].id);
          break;
        case 'n':
          document.getElementById('route-destination')?.focus();
          break;
        case '/':
          document.getElementById('fleet-search')?.focus();
          break;
        case 'a':
          app.acknowledgeAll();
          break;
        case 'Escape':
          app.selectTruck(null);
          break;
        case '?':
          app.stores.ui.setState((u) => ({ ...u, showHelp: true }));
          break;
        default: {
          const n = Number(e.key);
          if (n >= 1 && n <= PANELS.length) app.stores.ui.setState((u) => ({ ...u, panel: PANELS[n - 1] }));
          else return;
        }
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [app, getRows]);
}
