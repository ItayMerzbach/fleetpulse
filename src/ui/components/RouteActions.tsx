import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { RouteConflictError, canReapply, requiresConfirmation, type RouteConflict } from '../../domain/routes';
import type { Route, RouteStatus } from '../../domain/types';
import { RouteBusyError, RouteRuleError, type CreateRouteInput } from '../../services/RouteService';
import { ApiError, ValidationError } from '../../transport/errors';
import { useFleetPulse } from '../context';
import { fmtTime } from '../format';
import { Modal, useConfirm, useToast } from './Dialogs';

type VersionConflict = Extract<RouteConflict, { kind: 'version' }>;

interface RouteActions {
  create(input: CreateRouteInput): Promise<Route | null>;
  changeStatus(route: Route, to: RouteStatus): Promise<void>;
  reassign(route: Route, newTruckId: string): Promise<void>;
}

const RouteActionsContext = createContext<RouteActions | null>(null);

/**
 * All route mutations from any widget go through here, so confirmation,
 * conflict UX and error messages are identical everywhere.
 */
export function RouteActionsProvider({ children }: { children: ReactNode }) {
  const app = useFleetPulse();
  const confirm = useConfirm();
  const toast = useToast();
  const [conflict, setConflict] = useState<VersionConflict | null>(null);

  const handleError = useCallback(
    (err: unknown) => {
      if (err instanceof RouteConflictError) {
        const c = err.conflict;
        if (c.kind === 'version') setConflict(c);
        else if (c.kind === 'truck_assigned')
          toast('error', `${c.truckId} already has route ${c.currentRouteId ?? ''} — assigned by ${app.nameOf(c.assignedBy)}.`);
        else toast('error', `${c.newTruckId} is no longer available: ${c.serverMessage}`);
      } else if (err instanceof RouteBusyError) toast('info', err.message);
      else if (err instanceof RouteRuleError || err instanceof ValidationError) toast('error', err.message);
      else if (err instanceof ApiError) toast('error', `Server rejected the change: ${err.message}`);
      else toast('error', err instanceof Error ? err.message : 'Unexpected error');
    },
    [app, toast],
  );

  const actions: RouteActions = {
    async create(input) {
      try {
        const r = await app.routes.create(input);
        toast('success', `${r.id} assigned to ${r.truckId}`);
        return r;
      } catch (err) {
        if (err instanceof ValidationError) throw err; // forms show these inline
        handleError(err);
        return null;
      }
    },

    async changeStatus(route, to) {
      if (requiresConfirmation(to)) {
        const ok = await confirm({
          title: to === 'cancelled' ? 'Cancel route?' : 'Complete route?',
          body: (
            <p>
              Mark <b>{route.id}</b> ({route.destination}) on <b>{route.truckId}</b> as <b>{to}</b>. The truck will be released and
              become idle. This cannot be undone.
            </p>
          ),
          confirmLabel: to === 'cancelled' ? 'Cancel route' : 'Mark completed',
          danger: to === 'cancelled',
        });
        if (!ok) return;
      }
      try {
        await app.routes.updateStatus(route, to);
        toast('success', `${route.id} → ${to}`);
      } catch (err) {
        handleError(err);
      }
    },

    async reassign(route, newTruckId) {
      const ok = await confirm({
        title: 'Reassign route?',
        body: (
          <p>
            Move <b>{route.id}</b> ({route.destination}) from <b>{route.truckId}</b> to <b>{newTruckId}</b>. {route.truckId} will become
            idle.
          </p>
        ),
        confirmLabel: 'Reassign',
      });
      if (!ok) return;
      try {
        await app.routes.reassign(route, newTruckId);
        toast('success', `${route.id} moved to ${newTruckId}`);
      } catch (err) {
        handleError(err);
      }
    },
  };

  return (
    <RouteActionsContext.Provider value={actions}>
      {children}
      {conflict && (
        <ConflictDialog
          conflict={conflict}
          onClose={() => setConflict(null)}
          onApplyMine={async () => {
            setConflict(null);
            try {
              await app.routes.reapply(conflict);
              toast('success', `Your change was applied on top of the latest version of ${conflict.routeId}`);
            } catch (err) {
              handleError(err);
            }
          }}
        />
      )}
    </RouteActionsContext.Provider>
  );
}

export function useRouteActions(): RouteActions {
  const ctx = useContext(RouteActionsContext);
  if (!ctx) throw new Error('useRouteActions must be used inside <RouteActionsProvider>');
  return ctx;
}

// ---------------- Conflict dialog ----------------

function describeIntent(c: VersionConflict) {
  return c.intent.action === 'status' ? `set status to "${c.intent.to}"` : `reassign to ${c.intent.newTruckId}`;
}

export function ConflictDialog({
  conflict,
  onClose,
  onApplyMine,
}: {
  conflict: VersionConflict;
  onClose: () => void;
  onApplyMine: () => void;
}) {
  const app = useFleetPulse();
  const { mine, theirs } = conflict;
  const reapply = theirs ? canReapply(conflict.intent, theirs) : { ok: false as const, reason: 'Latest version unavailable' };

  // Three columns, so it is unambiguous what each choice leads to:
  //   what you saw  |  what it is now (their changes highlighted)  |  result if you apply yours on top
  const applyField: keyof Route = conflict.intent.action === 'status' ? 'status' : 'truckId';
  const applyValue = conflict.intent.action === 'status' ? conflict.intent.to : conflict.intent.newTruckId;
  const merged: Route | null = theirs && reapply.ok ? { ...theirs, [applyField]: applyValue } : null;

  const rows: Array<{ label: string; key: keyof Route }> = [
    { label: 'Status', key: 'status' },
    { label: 'Truck', key: 'truckId' },
    { label: 'Destination', key: 'destination' },
    { label: 'Priority', key: 'priority' },
    { label: 'Notes', key: 'notes' },
  ];
  const cell = (v: unknown) => (v === undefined || v === null || v === '' ? <span className="muted">(empty)</span> : String(v));

  return (
    <Modal title={`Conflict on ${conflict.routeId}`} onClose={onClose} wide>
      <p className="conflict-lead">
        <b>{app.nameOf(conflict.changedBy)}</b> changed this route while you were working on it. Your request to{' '}
        <b>{describeIntent(conflict)}</b> was <b>not applied</b> — nothing was overwritten.
      </p>
      <table className="conflict-table">
        <thead>
          <tr>
            <th />
            <th>What you saw (v{mine._version})</th>
            <th>
              Now {theirs ? `(v${theirs._version}, by ${app.nameOf(conflict.changedBy)})` : ''}
            </th>
            <th>If you apply your change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ label, key }) => {
            const theyChanged = theirs && String(mine[key] ?? '') !== String(theirs[key] ?? '');
            const youChange = key === applyField;
            return (
              <tr key={key}>
                <th>{label}</th>
                <td>{cell(mine[key])}</td>
                <td className={theyChanged ? 'diff-theirs' : ''}>{theirs ? cell(theirs[key]) : '—'}</td>
                <td className={youChange && merged ? 'diff-mine' : ''}>{merged ? cell(merged[key]) : '—'}</td>
              </tr>
            );
          })}
          {theirs && (
            <tr>
              <th>Last change</th>
              <td className="muted">—</td>
              <td>
                {app.nameOf(conflict.changedBy)}
                <span className="muted"> at {fmtTime(Math.max(theirs.lastModifiedAt ?? 0, theirs.reassignedAt ?? 0, theirs.assignedAt))}</span>
              </td>
              <td>{merged ? app.nameOf(app.identity.id) : '—'}</td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="small muted">
        <span className="swatch diff-theirs" /> changed by {app.nameOf(conflict.changedBy)} <span className="swatch diff-mine" /> your change
      </p>
      {!reapply.ok && <p className="text-warn">Your change can't be re-applied: {reapply.reason}</p>}
      <div className="modal-actions">
        <button className="btn" data-autofocus onClick={onClose}>
          Keep current version
        </button>
        <button className="btn btn-primary" disabled={!reapply.ok} onClick={onApplyMine} title={reapply.ok ? '' : reapply.reason}>
          Apply my change on top
        </button>
      </div>
    </Modal>
  );
}
