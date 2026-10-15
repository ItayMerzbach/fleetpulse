const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Dispatcher-Id, If-Match');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

// ============ FLEET STATE ============
const CITY_CENTER = { lat: 32.0853, lng: 34.7818 }; // Tel Aviv
const TRUCK_NAMES = ['Truck Alpha', 'Truck Bravo', 'Truck Charlie', 'Truck Delta',
  'Truck Echo', 'Truck Foxtrot', 'Truck Golf', 'Truck Hotel',
  'Truck India', 'Truck Juliet', 'Truck Kilo', 'Truck Lima'];

let trucks = {};
let routes = {};
let dispatchers = {};
let sseClients = new Set();
let nextRouteId = 1;

function initFleet() {
  TRUCK_NAMES.forEach((name, i) => {
    const id = `truck_${i + 1}`;
    const angle = (2 * Math.PI * i) / TRUCK_NAMES.length;
    const radius = 0.02 + Math.random() * 0.03;
    trucks[id] = {
      id,
      name,
      status: ['active', 'active', 'active', 'idle', 'active', 'active',
        'maintenance', 'active', 'active', 'idle', 'active', 'active'][i],
      location: {
        lat: CITY_CENTER.lat + Math.cos(angle) * radius,
        lng: CITY_CENTER.lng + Math.sin(angle) * radius
      },
      speed: 0,
      heading: Math.random() * 360,
      fuel: 40 + Math.random() * 55,
      engineTemp: 75 + Math.random() * 15,
      mileage: 10000 + Math.floor(Math.random() * 90000),
      lastUpdate: Date.now(),
      currentRouteId: null,
      _version: 1   // optimistic locking
    };
  });
}
initFleet();

// ============ QUIRKS (INTENTIONAL) ============
// QUIRK 1: GPS batch — when a truck regains signal, sends 10-30 buffered locations at once
// QUIRK 2: Fuel sensor reads 0% for 2-4 seconds during hard braking events
// QUIRK 3: Speed sensor stuck — truck_7 periodically reports 999 km/h for 5-10 seconds
// QUIRK 4: Route assignment conflict — 409 if version mismatch (optimistic locking)
// QUIRK 5: SSE telemetry sometimes arrives out of order (older GPS fix sent after newer one)
// QUIRK 6: WebSocket dispatcher presence has 20% chance of "ghost" — shows dispatcher as online for 10s after disconnect
// QUIRK 7: GET /api/fleet returns 503 under "load" (15% chance) with Retry-After header
// QUIRK 8: Route status update can race with reassignment — PATCH returns 409 if route was reassigned mid-update

function simulateTrucks() {
  Object.values(trucks).forEach(truck => {
    if (truck.status === 'maintenance') return;
    if (truck.status === 'idle') {
      truck.speed = 0;
      truck.engineTemp = Math.max(20, truck.engineTemp - 0.5);
      return;
    }

    // Normal movement
    const headingRad = (truck.heading + (Math.random() - 0.5) * 30) * Math.PI / 180;
    truck.heading = (truck.heading + (Math.random() - 0.5) * 30 + 360) % 360;
    truck.speed = Math.max(0, Math.min(80, truck.speed + (Math.random() - 0.3) * 10));

    const moveScale = 0.00005 * (truck.speed / 40);
    truck.location.lat += Math.cos(headingRad) * moveScale;
    truck.location.lng += Math.sin(headingRad) * moveScale;

    // Keep trucks near city center
    const distFromCenter = Math.sqrt(
      Math.pow(truck.location.lat - CITY_CENTER.lat, 2) +
      Math.pow(truck.location.lng - CITY_CENTER.lng, 2)
    );
    if (distFromCenter > 0.05) {
      truck.heading = (Math.atan2(
        CITY_CENTER.lng - truck.location.lng,
        CITY_CENTER.lat - truck.location.lat
      ) * 180 / Math.PI + 360) % 360;
    }

    truck.fuel = Math.max(5, truck.fuel - 0.01 - (truck.speed / 8000));
    truck.engineTemp = 75 + truck.speed * 0.3 + (Math.random() - 0.5) * 5;
    truck.lastUpdate = Date.now();
    truck._version++;
  });
}

// QUIRK 3: Speed sensor stuck on truck_7
let truck7SensorStuck = false;
setInterval(() => {
  if (!truck7SensorStuck && Math.random() < 0.08) {
    truck7SensorStuck = true;
    setTimeout(() => { truck7SensorStuck = false; }, 5000 + Math.random() * 5000);
  }
}, 3000);

// QUIRK 2: Fuel sensor glitch during braking
let fuelGlitchTrucks = new Set();
setInterval(() => {
  Object.values(trucks).forEach(truck => {
    if (truck.status !== 'active') return;
    if (!fuelGlitchTrucks.has(truck.id) && truck.speed > 40 && Math.random() < 0.05) {
      fuelGlitchTrucks.add(truck.id);
      setTimeout(() => { fuelGlitchTrucks.delete(truck.id); }, 2000 + Math.random() * 2000);
    }
  });
}, 2000);

function sendTelemetrySSE() {
  const timestamp = Date.now();
  const readings = Object.values(trucks).map(truck => {
    const reading = {
      truckId: truck.id,
      location: { ...truck.location },
      speed: truck7SensorStuck && truck.id === 'truck_7' ? 999 : truck.speed,
      heading: truck.heading,
      fuel: fuelGlitchTrucks.has(truck.id) ? 0 : truck.fuel,
      engineTemp: truck.engineTemp,
      status: truck.status,
      timestamp
    };
    return reading;
  });

  // QUIRK 1: GPS batch — random truck sends 10-30 old readings at once
  if (Math.random() < 0.1) {
    const batchTruck = Object.values(trucks)[Math.floor(Math.random() * 12)];
    if (batchTruck.status === 'active') {
      const batchSize = 10 + Math.floor(Math.random() * 20);
      const batchReadings = [];
      for (let i = batchSize; i > 0; i--) {
        batchReadings.push({
          truckId: batchTruck.id,
          location: {
            lat: batchTruck.location.lat + (Math.random() - 0.5) * 0.002,
            lng: batchTruck.location.lng + (Math.random() - 0.5) * 0.002
          },
          speed: batchTruck.speed + (Math.random() - 0.5) * 10,
          heading: batchTruck.heading,
          fuel: batchTruck.fuel,
          engineTemp: batchTruck.engineTemp,
          status: batchTruck.status,
          timestamp: timestamp - (i * 2000),  // 2 seconds apart, going back in time
          _batch: true,
          _batchIndex: batchSize - i,
          _batchTotal: batchSize
        });
      }
      // Send batch all at once
      const batchPayload = JSON.stringify({ type: 'gps_batch', truckId: batchTruck.id, readings: batchReadings });
      sseClients.forEach(res => {
        try { res.write(`data: ${batchPayload}\n\n`); } catch(e) {}
      });
    }
  }

  // QUIRK 5: Out of order — 10% chance a reading arrives with older timestamp
  if (Math.random() < 0.1 && readings.length > 0) {
    const idx = Math.floor(Math.random() * readings.length);
    readings[idx].timestamp = timestamp - 3000 - Math.random() * 5000;
    readings[idx]._reordered = true;
  }

  // Normal telemetry send
  const payload = JSON.stringify({ type: 'telemetry', readings, timestamp });
  sseClients.forEach(res => {
    try { res.write(`data: ${payload}\n\n`); } catch(e) {}
  });
}

// Simulate every 2 seconds
setInterval(() => {
  simulateTrucks();
  sendTelemetrySSE();
}, 2000);

// ============ DISPATCHER PRESENCE ============
function broadcastWS(message, excludeWs = null) {
  wss.clients.forEach(ws => {
    if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  });
}

// ============ REST API ============

// GET /api/fleet — all trucks
app.get('/api/fleet', (req, res) => {
  // QUIRK 7: 15% chance of 503
  if (Math.random() < 0.15) {
    res.set('Retry-After', '3');
    return res.status(503).json({ error: 'Service under heavy load' });
  }
  const fleet = Object.values(trucks).map(t => ({
    id: t.id, name: t.name, status: t.status,
    location: t.location, speed: t.speed, heading: t.heading,
    fuel: t.fuel, engineTemp: t.engineTemp,
    currentRouteId: t.currentRouteId, _version: t._version
  }));
  res.json({ fleet, timestamp: Date.now() });
});

// GET /api/fleet/:truckId — single truck detail
app.get('/api/fleet/:truckId', (req, res) => {
  const truck = trucks[req.params.truckId];
  if (!truck) return res.status(404).json({ error: 'Truck not found' });
  res.json(truck);
});

// GET /api/routes — all routes
app.get('/api/routes', (req, res) => {
  res.json({ routes: Object.values(routes), timestamp: Date.now() });
});

// POST /api/routes — create a new route
app.post('/api/routes', (req, res) => {
  const dispatcherId = req.headers['x-dispatcher-id'];
  if (!dispatcherId) return res.status(401).json({ error: 'X-Dispatcher-Id header required' });

  const { truckId, destination, priority, notes } = req.body;
  if (!truckId || !destination) return res.status(400).json({ error: 'truckId and destination required' });

  const truck = trucks[truckId];
  if (!truck) return res.status(404).json({ error: 'Truck not found' });

  // Check if truck already has a route
  if (truck.currentRouteId) {
    return res.status(409).json({
      error: 'Truck already assigned',
      currentRouteId: truck.currentRouteId,
      assignedBy: routes[truck.currentRouteId]?.assignedBy
    });
  }

  const routeId = `route_${nextRouteId++}`;
  const route = {
    id: routeId,
    truckId,
    destination,
    priority: priority || 'normal',
    notes: notes || '',
    status: 'assigned',      // assigned | in-progress | completed | cancelled
    assignedBy: dispatcherId,
    assignedAt: Date.now(),
    _version: 1
  };

  routes[routeId] = route;
  truck.currentRouteId = routeId;
  truck.status = 'active';
  truck._version++;

  broadcastWS({
    type: 'route_assigned',
    route,
    truckId,
    assignedBy: dispatcherId,
    truckVersion: truck._version,
    timestamp: Date.now()
  });

  res.status(201).json(route);
});

// PATCH /api/routes/:routeId — update route status
app.patch('/api/routes/:routeId', (req, res) => {
  const dispatcherId = req.headers['x-dispatcher-id'];
  if (!dispatcherId) return res.status(401).json({ error: 'X-Dispatcher-Id header required' });

  const route = routes[req.params.routeId];
  if (!route) return res.status(404).json({ error: 'Route not found' });

  // QUIRK 4 + 8: Optimistic locking via If-Match header
  const ifMatch = req.headers['if-match'];
  if (ifMatch && parseInt(ifMatch) !== route._version) {
    return res.status(409).json({
      error: 'Route was modified by another dispatcher',
      currentVersion: route._version,
      yourVersion: parseInt(ifMatch),
      lastModifiedBy: route.lastModifiedBy || route.assignedBy
    });
  }

  const { status, notes, priority } = req.body;

  // Artificial delay to make race conditions more visible
  const delay = 200 + Math.random() * 800;
  setTimeout(() => {
    // Re-check version after delay (QUIRK 8: race with reassignment)
    if (ifMatch && parseInt(ifMatch) !== route._version) {
      return res.status(409).json({
        error: 'Route was modified during processing',
        currentVersion: route._version
      });
    }

    if (status) route.status = status;
    if (notes) route.notes = notes;
    if (priority) route.priority = priority;
    route.lastModifiedBy = dispatcherId;
    route.lastModifiedAt = Date.now();
    route._version++;

    if (status === 'completed' || status === 'cancelled') {
      const truck = trucks[route.truckId];
      if (truck) {
        truck.currentRouteId = null;
        truck.status = 'idle';
        truck._version++;
      }
    }

    broadcastWS({
      type: 'route_updated',
      route,
      updatedBy: dispatcherId,
      timestamp: Date.now()
    });

    res.json(route);
  }, delay);
});

// PUT /api/routes/:routeId/reassign — reassign route to different truck
app.put('/api/routes/:routeId/reassign', (req, res) => {
  const dispatcherId = req.headers['x-dispatcher-id'];
  if (!dispatcherId) return res.status(401).json({ error: 'X-Dispatcher-Id header required' });

  const route = routes[req.params.routeId];
  if (!route) return res.status(404).json({ error: 'Route not found' });

  const { newTruckId } = req.body;
  const newTruck = trucks[newTruckId];
  if (!newTruck) return res.status(404).json({ error: 'Target truck not found' });
  if (newTruck.currentRouteId) {
    return res.status(409).json({ error: 'Target truck already has an assigned route' });
  }
  if (newTruck.status === 'maintenance') {
    return res.status(400).json({ error: 'Cannot assign to truck in maintenance' });
  }

  const oldTruck = trucks[route.truckId];
  if (oldTruck) {
    oldTruck.currentRouteId = null;
    oldTruck.status = 'idle';
    oldTruck._version++;
  }

  route.truckId = newTruckId;
  route.reassignedBy = dispatcherId;
  route.reassignedAt = Date.now();
  route._version++;

  newTruck.currentRouteId = route.id;
  newTruck.status = 'active';
  newTruck._version++;

  broadcastWS({
    type: 'route_reassigned',
    route,
    oldTruckId: oldTruck?.id,
    newTruckId,
    reassignedBy: dispatcherId,
    timestamp: Date.now()
  });

  res.json(route);
});

// POST /api/fleet/:truckId/alert — dispatcher sends alert to truck
app.post('/api/fleet/:truckId/alert', (req, res) => {
  const dispatcherId = req.headers['x-dispatcher-id'];
  const truck = trucks[req.params.truckId];
  if (!truck) return res.status(404).json({ error: 'Truck not found' });

  const { message, severity } = req.body;
  const alert = {
    id: crypto.randomUUID(),
    truckId: truck.id,
    message: message || 'Alert from dispatch',
    severity: severity || 'info',
    sentBy: dispatcherId,
    timestamp: Date.now(),
    acknowledged: false
  };

  broadcastWS({ type: 'truck_alert', alert });
  res.status(201).json(alert);
});

// POST /api/reset — development reset
app.post('/api/reset', (req, res) => {
  routes = {};
  nextRouteId = 1;
  dispatchers = {};
  initFleet();
  broadcastWS({ type: 'fleet_reset', timestamp: Date.now() });
  res.json({ success: true });
});

// GET /api/telemetry/stream — SSE endpoint
app.get('/api/telemetry/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write(`data: ${JSON.stringify({ type: 'connected', truckCount: 12, timestamp: Date.now() })}\n\n`);
  sseClients.add(res);

  const heartbeat = setInterval(() => {
    res.write(`data: ${JSON.stringify({ type: 'heartbeat', timestamp: Date.now() })}\n\n`);
  }, 15000);

  req.on('close', () => {
    sseClients.delete(res);
    clearInterval(heartbeat);
  });
});

// GET /api/telemetry/history/:truckId — last N readings for a truck
app.get('/api/telemetry/history/:truckId', (req, res) => {
  const truck = trucks[req.params.truckId];
  if (!truck) return res.status(404).json({ error: 'Truck not found' });
  const limit = Math.min(parseInt(req.query.limit) || 60, 300);
  const history = [];
  for (let i = limit; i > 0; i--) {
    history.push({
      truckId: truck.id,
      location: {
        lat: truck.location.lat + (Math.random() - 0.5) * 0.001 * i,
        lng: truck.location.lng + (Math.random() - 0.5) * 0.001 * i
      },
      speed: Math.max(0, truck.speed + (Math.random() - 0.5) * 20),
      fuel: Math.min(100, truck.fuel + i * 0.02),
      engineTemp: truck.engineTemp + (Math.random() - 0.5) * 5,
      timestamp: Date.now() - i * 2000
    });
  }
  res.json({ history, count: history.length });
});

// ============ WEBSOCKET ============
wss.on('connection', (ws) => {
  let dispatcherId = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'register_dispatcher') {
        dispatcherId = msg.dispatcherId || `dispatcher_${crypto.randomUUID().slice(0, 8)}`;
        dispatchers[dispatcherId] = {
          id: dispatcherId,
          name: msg.name || 'Anonymous',
          connectedAt: Date.now(),
          ws
        };
        ws.send(JSON.stringify({ type: 'registered', dispatcherId }));
        broadcastWS({
          type: 'dispatcher_joined',
          dispatcherId,
          name: msg.name || 'Anonymous',
          timestamp: Date.now(),
          activeDispatchers: Object.keys(dispatchers).length
        }, ws);
      }

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      }

      // Dispatcher "looking at" a truck (cursor presence)
      if (msg.type === 'viewing_truck') {
        broadcastWS({
          type: 'dispatcher_viewing',
          dispatcherId,
          truckId: msg.truckId,
          timestamp: Date.now()
        }, ws);
      }
    } catch(e) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
    }
  });

  ws.on('close', () => {
    if (dispatcherId) {
      // QUIRK 6: 20% chance of ghost presence (delayed removal)
      if (Math.random() < 0.2) {
        setTimeout(() => {
          delete dispatchers[dispatcherId];
          broadcastWS({
            type: 'dispatcher_left',
            dispatcherId,
            timestamp: Date.now(),
            activeDispatchers: Object.keys(dispatchers).length
          });
        }, 10000);
      } else {
        delete dispatchers[dispatcherId];
        broadcastWS({
          type: 'dispatcher_left',
          dispatcherId,
          timestamp: Date.now(),
          activeDispatchers: Object.keys(dispatchers).length
        });
      }
    }
  });
});

// ============ START ============
const PORT = 3000;
server.listen(PORT, () => {
  console.log(`🚛 FleetPulse Server running on port ${PORT}`);
  console.log(`   HTTP API: http://localhost:${PORT}/api/fleet`);
  console.log(`   Telemetry SSE: http://localhost:${PORT}/api/telemetry/stream`);
  console.log(`   WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`   Reset: POST http://localhost:${PORT}/api/reset`);
  console.log('');
  console.log('   QUIRKS ACTIVE:');
  console.log('   1. GPS batch (10-30 buffered readings at once on signal recovery)');
  console.log('   2. Fuel sensor reads 0% during hard braking (2-4s)');
  console.log('   3. Truck #7 speed sensor stuck at 999 km/h (periodic, 5-10s)');
  console.log('   4. Route assignment 409 on version mismatch (optimistic locking)');
  console.log('   5. Out-of-order GPS timestamps (10% chance)');
  console.log('   6. Ghost dispatcher presence (20% delayed disconnect)');
  console.log('   7. GET /api/fleet returns 503 under load (15%)');
  console.log('   8. Route PATCH races with reassignment (409 during processing)');
});
