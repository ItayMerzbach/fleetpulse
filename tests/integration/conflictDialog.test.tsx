import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createFleetPulse } from '../../src/app/createFleetPulse';
import type { RouteConflict } from '../../src/domain/routes';
import { ConflictDialog } from '../../src/ui/components/RouteActions';
import { FleetPulseProvider } from '../../src/ui/context';
import { route } from '../helpers';

const app = createFleetPulse({ apiBaseUrl: 'http://x', wsUrl: 'ws://x', identity: { id: 'dana-0001', name: 'Dana' } });

function renderDialog(conflict: Extract<RouteConflict, { kind: 'version' }>) {
  const onApplyMine = vi.fn();
  const onClose = vi.fn();
  render(
    <FleetPulseProvider app={app}>
      <ConflictDialog conflict={conflict} onClose={onClose} onApplyMine={onApplyMine} />
    </FleetPulseProvider>,
  );
  return { onApplyMine, onClose };
}

describe('ConflictDialog', () => {
  it('names who changed the route, shows both versions and the merged result', async () => {
    const { onApplyMine } = renderDialog({
      kind: 'version',
      routeId: 'route_1',
      intent: { action: 'status', to: 'completed' },
      mine: route({ _version: 3, status: 'in-progress', notes: 'gate 5' }),
      theirs: route({ _version: 4, status: 'in-progress', notes: 'gate 7', lastModifiedBy: 'omer-1a2b', lastModifiedAt: 5000 }),
      changedBy: 'omer-1a2b',
      serverMessage: 'Route was modified by another dispatcher',
    });
    expect(screen.getByText(/changed this route while you were working on it/)).toHaveTextContent('Omer');
    expect(screen.getByText('gate 5')).toBeInTheDocument(); // what I saw
    expect(screen.getAllByText('gate 7')).toHaveLength(2); // theirs + merged result keeps their note
    expect(screen.getByText('completed')).toBeInTheDocument(); // my change in the merged column
    await userEvent.click(screen.getByRole('button', { name: /apply my change on top/i }));
    expect(onApplyMine).toHaveBeenCalled();
  });

  it('disables "apply mine" with a reason when the route was closed by the other dispatcher', () => {
    renderDialog({
      kind: 'version',
      routeId: 'route_1',
      intent: { action: 'status', to: 'in-progress' },
      mine: route({ _version: 1 }),
      theirs: route({ _version: 2, status: 'cancelled', lastModifiedBy: 'omer-1a2b', lastModifiedAt: 5000 }),
      changedBy: 'omer-1a2b',
      serverMessage: '',
    });
    expect(screen.getByRole('button', { name: /apply my change on top/i })).toBeDisabled();
    expect(screen.getByText(/can't be re-applied/)).toHaveTextContent('cancelled');
  });
});
