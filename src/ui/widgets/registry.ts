import type { ComponentType } from 'react';

export interface DetailWidgetProps {
  truckId: string;
}

/**
 * Detail-panel plugin contract. The panel knows nothing about specific widgets:
 * it renders whatever is registered for the selected vehicle's type, each in
 * its own error boundary. New capability (e.g. a battery widget for an EV
 * type, or a temperature-chain widget for refrigerated trucks) = one new
 * file + one register call.
 */
export interface DetailWidget {
  id: string;
  title: string;
  order: number;
  /** Omit to apply to every vehicle type. */
  appliesTo?: (vehicleTypeId: string) => boolean;
  Component: ComponentType<DetailWidgetProps>;
}

export class WidgetRegistry {
  private widgets = new Map<string, DetailWidget>();

  register(widget: DetailWidget): this {
    if (this.widgets.has(widget.id)) throw new Error(`Widget "${widget.id}" already registered`);
    this.widgets.set(widget.id, widget);
    return this;
  }

  forVehicleType(typeId: string): DetailWidget[] {
    return [...this.widgets.values()]
      .filter((w) => !w.appliesTo || w.appliesTo(typeId))
      .sort((a, b) => a.order - b.order);
  }
}
