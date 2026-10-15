import { ActivityWidget } from './ActivityWidget';
import { AlertWidget } from './AlertWidget';
import { WidgetRegistry } from './registry';
import { RouteWidget } from './RouteWidget';
import { TelemetryWidget } from './TelemetryWidget';

export const detailWidgets = new WidgetRegistry()
  .register({ id: 'telemetry', title: 'Live telemetry', order: 10, Component: TelemetryWidget })
  .register({ id: 'route', title: 'Route', order: 20, Component: RouteWidget })
  .register({ id: 'alert', title: 'Send alert to driver', order: 30, Component: AlertWidget })
  .register({ id: 'activity', title: 'Truck activity', order: 40, Component: ActivityWidget });
