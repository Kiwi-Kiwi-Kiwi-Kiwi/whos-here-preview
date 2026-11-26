async function loadThree() {
  try {
    return await import("./vendor/three.module.js");
  } catch (error) {
    return await import("https://unpkg.com/three@0.170.0/build/three.module.js");
  }
}

const BIOMES = [
  [0.15, 0.55, 0.95],
  [0.97, 0.98, 1],
  [0.9, 0.88, 0.8],
  [0.72, 0.76, 0.82],
  [0.7, 0.86, 0.74],
  [0.94, 0.86, 0.62],
];

function toLonLat(mapX, mapY, frame) {
  return {
    lon: ((mapX - frame.x) / frame.w) * 360 - 180,
    lat: 90 - ((mapY - frame.y) / frame.h) * 180,
  };
}

function fromLonLat(lon, lat, frame) {
  return {
    mapX: frame.x + ((lon + 180) / 360) * frame.w,
    mapY: frame.y + ((90 - lat) / 180) * frame.h,
  };
}

function lonLatToVector(THREE, lon, lat, radius) {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((lon + 180) * Math.PI) / 180;
  return new THREE.Vector3(
    radius * Math.sin(phi) * Math.sin(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.cos(theta)
  );
}

function vectorToLonLat(vector) {
  const radius = Math.hypot(vector.x, vector.y, vector.z) || 1;
  const lat = 90 - (Math.acos(Math.max(-1, Math.min(1, vector.y / radius))) * 180) / Math.PI;
  let lon = (Math.atan2(vector.x, vector.z) * 180) / Math.PI - 180;
  if (lon < -180) lon += 360;
  if (lon > 180) lon -= 360;
  return { lon: lon, lat: lat };
}

export async function mountGlobe(canvas, world, hooks) {
  const THREE = await loadThree();
  const frame = world.projection.frame;
  const crop = world.crop;
  const cols = world.grid.cols;
  const rows = world.grid.rows;
  const reliefScale = 0.2;

  function heightAt(lon, lat) {
    const map = fromLonLat(lon, lat, frame);
    const col = Math.round(((map.mapX - crop.x) / crop.w) * (cols - 1));
    const row = Math.round(((map.mapY - crop.y) / crop.h) * (rows - 1));
    const c = Math.max(0, Math.min(cols - 1, col));
    const r = Math.max(0, Math.min(rows - 1, row));
    return world.heights[r * cols + c] || 0;
  }

  function cellHeight(col, row) {
    let sum = 0;
    let count = 0;
    for (const [dx, dy] of [
      [-1, -1],
      [0, -1],
      [-1, 0],
      [0, 0],
    ]) {
      const x = col + dx;
      const y = row + dy;
      if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
      sum += world.heights[y * cols + x];
      count += 1;
    }
    return count ? sum / count : 0;
  }

  function corner(col, row) {
    const mapX = crop.x + (col / (cols - 1)) * crop.w;
    const mapY = crop.y + (row / (rows - 1)) * crop.h;
    const geo = toLonLat(mapX, mapY, frame);
    return lonLatToVector(THREE, geo.lon, geo.lat, 1 + cellHeight(col, row) * reliefScale);
  }

  const landPositions = [];
  const landColors = [];
  const tris = [
    [0, 2, 1],
    [0, 3, 2],
  ];
  const coastRings = (world.coastlines || []).map((ring) => ring.points);
  function ringHas(ring, x, y) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const yi = ring[i].y;
      const yj = ring[j].y;
      const xi = ring[i].x;
      const xj = ring[j].x;
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-9) + xi) inside = !inside;
    }
    return inside;
  }
  function insideCoast(x, y) {
    if (!coastRings.length) return true;
    return coastRings.some((ring) => ringHas(ring, x, y));
  }
  function snapCoast(x, y) {
    let bestX = x;
    let bestY = y;
    let best = 1e9;
    for (const ring of coastRings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        const abx = b.x - a.x;
        const aby = b.y - a.y;
        const len2 = abx * abx + aby * aby || 1;
        const t = Math.max(0, Math.min(1, ((x - a.x) * abx + (y - a.y) * aby) / len2));
        const px = a.x + abx * t;
        const py = a.y + aby * t;
        const dist = (px - x) * (px - x) + (py - y) * (py - y);
        if (dist < best) {
          best = dist;
          bestX = px;
          bestY = py;
        }
      }
    }
    return [bestX, bestY];
  }
  function sampleHeight(gx, gy) {
    const x = Math.max(0, Math.min(cols - 1.001, gx));
    const y = Math.max(0, Math.min(rows - 1.001, gy));
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const tx = x - x0;
    const ty = y - y0;
    const at = function (cx, cy) {
      return world.heights[cy * cols + cx] || 0;
    };
    const x1 = Math.min(cols - 1, x0 + 1);
    const y1 = Math.min(rows - 1, y0 + 1);
    return at(x0, y0) * (1 - tx) * (1 - ty) + at(x1, y0) * tx * (1 - ty) + at(x0, y1) * (1 - tx) * ty + at(x1, y1) * tx * ty;
  }
  function gridVertex(gx, gy) {
    const mapX = crop.x + (gx / (cols - 1)) * crop.w;
    const mapY = crop.y + (gy / (rows - 1)) * crop.h;
    const geo = toLonLat(mapX, mapY, frame);
    return lonLatToVector(THREE, geo.lon, geo.lat, 1 + sampleHeight(gx, gy) * reliefScale);
  }
  for (let row = 0; row < rows - 1; row++) {
    for (let col = 0; col < cols - 1; col++) {
      const raw = [
        [col, row],
        [col + 1, row],
        [col + 1, row + 1],
        [col, row + 1],
      ];
      const flags = raw.map((point) => insideCoast(point[0], point[1]));
      const centerIn = insideCoast(col + 0.5, row + 0.5);
      if (!centerIn && flags.every((flag) => !flag)) continue;
      const shaped = [];
      let keep = true;
      for (let i = 0; i < raw.length; i++) {
        if (flags[i]) {
          shaped.push(raw[i]);
          continue;
        }
        const snapped = snapCoast(raw[i][0], raw[i][1]);
        const gap = Math.hypot(snapped[0] - raw[i][0], snapped[1] - raw[i][1]);
        if (gap > 2.4 && !centerIn) {
          keep = false;
          break;
        }
        shaped.push(snapped);
      }
      if (!keep) continue;
      const biome = world.biomes[row * cols + col];
      const tint = BIOMES[biome === 0 ? 1 : biome] || BIOMES[1];
      const corners = shaped.map((point) => gridVertex(point[0], point[1]));
      for (const triangle of tris) {
        for (const index of triangle) {
          landPositions.push(corners[index].x, corners[index].y, corners[index].z);
          landColors.push(tint[0], tint[1], tint[2]);
        }
      }
    }
  }

  function meshFrom(positions, colors, material) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    if (colors) geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    return new THREE.Mesh(geometry, material);
  }

  const terrain = meshFrom(
    landPositions,
    landColors,
    new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })
  );
  const skirt = [];
  const lon0 = world.bounds.lon[0] - 100;
  const lon1 = world.bounds.lon[1] + 100;
  const lat0 = Math.max(-89, world.bounds.lat[0] - 36);
  const lat1 = Math.min(89, world.bounds.lat[1] + 36);
  const skirtLon = 80;
  const skirtLat = 36;
  for (let j = 0; j < skirtLat; j++) {
    for (let i = 0; i < skirtLon; i++) {
      const aLon = lon0 + ((lon1 - lon0) * i) / skirtLon;
      const bLon = lon0 + ((lon1 - lon0) * (i + 1)) / skirtLon;
      const aLat = lat1 - ((lat1 - lat0) * j) / skirtLat;
      const bLat = lat1 - ((lat1 - lat0) * (j + 1)) / skirtLat;
      const points = [
        lonLatToVector(THREE, aLon, aLat, 0.99),
        lonLatToVector(THREE, bLon, aLat, 0.99),
        lonLatToVector(THREE, bLon, bLat, 0.99),
        lonLatToVector(THREE, aLon, bLat, 0.99),
      ];
      for (const triangle of tris) {
        for (const index of triangle) skirt.push(points[index].x, points[index].y, points[index].z);
      }
    }
  }
  const ocean = meshFrom(
    skirt,
    null,
    new THREE.MeshLambertMaterial({ color: 0x2f92f0, flatShading: true })
  );

  const markerGroup = new THREE.Group();
  const markerMesh = new Map();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1678d4);
  scene.add(ocean, terrain, markerGroup);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb7d4ee, 1.35));
  const sun = new THREE.DirectionalLight(0xfff7ea, 1.7);
  sun.position.set(-2, 3, 2);
  scene.add(sun);


  const camera = new THREE.PerspectiveCamera(72, 1, 0.00004, 20);
  const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const markers = hooks.markers;
  const mapView = hooks.mapView || canvas.parentElement;
  const hint = document.querySelector("#flight-hint");
  const prompt = document.querySelector("#flight-prompt");
  const readout = document.querySelector("#flight-readout");
  const dom = new Map();
  let editing = false;
  let dragging = null;
  let selectedPlace = (hooks.places.places || [])[0] || null;
  let running = true;
  let mapFocused = false;
  const keys = new Set();
  const runway = world.runway || {
    lon: (world.bounds.lon[0] + world.bounds.lon[1]) / 2,
    lat: (world.bounds.lat[0] + world.bounds.lat[1]) / 2,
    heading: 90,
  };
  const player = {
    mode: "foot",
    lon: runway.lon,
    lat: runway.lat,
    yaw: (runway.heading * Math.PI) / 180,
    pitch: -0.05,
    speed: 0,
    throttle: 0.2,
    climb: 0,
    altitude: 0,
  };

  function offsetLonLat(lon, lat, eastUnits, northUnits) {
    const dLat = (northUnits * 180) / Math.PI;
    const dLon = (eastUnits * 180) / Math.PI / Math.max(0.25, Math.cos((lat * Math.PI) / 180));
    return { lon: lon + dLon, lat: lat + dLat };
  }

  function headingOffset(lon, lat, headingDeg, distance) {
    const heading = (headingDeg * Math.PI) / 180;
    return offsetLonLat(lon, lat, Math.sin(heading) * distance, Math.cos(heading) * distance);
  }

  const beside = headingOffset(runway.lon, runway.lat, runway.heading + 180, 0.042);
  player.lon = beside.lon;
  player.lat = beside.lat;
  player.pitch = -0.18;

  function cellBiome(lon, lat) {
    const map = fromLonLat(lon, lat, frame);
    if (map.mapX < crop.x || map.mapY < crop.y || map.mapX > crop.x + crop.w || map.mapY > crop.y + crop.h) return 0;
    const col = Math.floor(((map.mapX - crop.x) / crop.w) * cols);
    const row = Math.floor(((map.mapY - crop.y) / crop.h) * rows);
    if (col < 0 || row < 0 || col >= cols || row >= rows) return 0;
    return world.biomes[row * cols + col];
  }

  function onLand(lon, lat) {
    return cellBiome(lon, lat) !== 0;
  }

  function placeObject(object, lon, lat, heading, lift) {
    const radius = 1 + heightAt(lon, lat) * reliefScale + lift;
    const pos = lonLatToVector(THREE, lon, lat, radius);
    const normal = pos.clone().normalize();
    const worldUp = new THREE.Vector3(0, 1, 0);
    const east = new THREE.Vector3().crossVectors(worldUp, normal).normalize();
    const north = new THREE.Vector3().crossVectors(normal, east).normalize();
    const forward = north
      .clone()
      .multiplyScalar(Math.cos(heading))
      .add(east.clone().multiplyScalar(Math.sin(heading)))
      .normalize();
    const right = new THREE.Vector3().crossVectors(forward, normal).normalize();
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();
    object.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, forward));
    object.position.copy(pos);
    return { pos: pos, normal: normal, forward: forward, east: east, north: north };
  }

  function makePlane() {
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.0022, 0.0018, 0.011),
      new THREE.MeshLambertMaterial({ color: 0xf4f7fb })
    );
    const wing = new THREE.Mesh(
      new THREE.BoxGeometry(0.016, 0.00028, 0.0024),
      new THREE.MeshLambertMaterial({ color: 0xd5dde6 })
    );
    wing.position.z = 0.0005;
    const tail = new THREE.Mesh(
      new THREE.BoxGeometry(0.0034, 0.00015, 0.0011),
      new THREE.MeshLambertMaterial({ color: 0xd5dde6 })
    );
    tail.position.z = -0.0025;
    const fin = new THREE.Mesh(
      new THREE.BoxGeometry(0.00016, 0.0013, 0.0011),
      new THREE.MeshLambertMaterial({ color: 0xe7a15a })
    );
    fin.position.set(0, 0.0007, -0.0025);
    const prop = new THREE.Mesh(
      new THREE.BoxGeometry(0.0024, 0.00016, 0.00016),
      new THREE.MeshLambertMaterial({ color: 0x24282e })
    );
    prop.position.z = 0.00335;
    group.add(body, wing, tail, fin, prop);
    group.userData.prop = prop;
    return group;
  }

  function makeRunway() {
    const group = new THREE.Group();
    const strip = new THREE.Mesh(
      new THREE.BoxGeometry(0.0055, 0.00045, 0.055),
      new THREE.MeshLambertMaterial({ color: 0x242a34 })
    );
    group.add(strip);
    for (let i = -5; i <= 5; i++) {
      const dash = new THREE.Mesh(
        new THREE.BoxGeometry(0.00032, 0.0004, 0.0013),
        new THREE.MeshLambertMaterial({ color: 0xf7f4ee })
      );
      dash.position.z = i * 0.0026;
      group.add(dash);
    }
    return group;
  }

  const eyeAnchor = new THREE.Object3D();
  const plane = makePlane();
  const runwayMesh = makeRunway();
  scene.add(plane, runwayMesh);
  let planeLon = runway.lon;
  let planeLat = runway.lat;
  let planeHeading = (runway.heading * Math.PI) / 180;

  function surfacePoint(place) {
    const height = heightAt(place.lon, place.lat);
    return lonLatToVector(THREE, place.lon, place.lat, 1 + height * reliefScale + 0.012);
  }

  function rebuildMarkers() {
    markerGroup.clear();
    markerMesh.clear();
    markers.replaceChildren();
    dom.clear();
    for (const place of hooks.places.places || []) {
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(0.004, 0.012, 5),
        new THREE.MeshLambertMaterial({ color: 0xe7a15a })
      );
      markerGroup.add(cone);
      markerMesh.set(place.id, cone);
      const pin = document.createElement("button");
      pin.type = "button";
      pin.className = "pin place";
      pin.dataset.place = place.id;
      if (place.assetId) pin.dataset.id = place.assetId;
      pin.title = place.name;
      const short = { village: "Village", iceberg: "Iceberg", wreck: "Wreck", penguins: "Penguins", ship: "Zuko's ship" };
      pin.textContent = short[place.id] || place.name;
      pin.addEventListener("click", function (event) {
        event.stopPropagation();
        if (editing) {
          selectedPlace = place;
          event.preventDefault();
          return;
        }
        if (place.assetId && hooks.onMarkerClick) hooks.onMarkerClick(place.assetId);
      });
      pin.addEventListener("pointerdown", function (event) {
        if (!editing) return;
        dragging = place.id;
        selectedPlace = place;
        pin.setPointerCapture(event.pointerId);
        event.stopPropagation();
      });
      pin.addEventListener("pointermove", function (event) {
        if (dragging !== place.id) return;
        movePlace(place, event.clientX, event.clientY);
      });
      pin.addEventListener("pointerup", function () {
        dragging = null;
      });
      markers.append(pin);
      dom.set(place.id, pin);
    }
  }

  function movePlace(place, clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects([terrain, ocean], false)[0];
    if (!hit) return;
    const geo = vectorToLonLat(hit.point);
    place.lon = Math.round(geo.lon * 1000) / 1000;
    place.lat = Math.round(geo.lat * 1000) / 1000;
    const map = fromLonLat(place.lon, place.lat, frame);
    place.mapX = Math.round(map.mapX);
    place.mapY = Math.round(map.mapY);
  }

  function resize() {
    const width = canvas.clientWidth || 1;
    const height = canvas.clientHeight || 1;
    if (canvas.width !== Math.floor(width * renderer.getPixelRatio()) || canvas.height !== Math.floor(height * renderer.getPixelRatio())) {
      renderer.setSize(width, height, false);
    }
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  function basis(lon, lat, heading) {
    const pos = lonLatToVector(THREE, lon, lat, 1);
    const normal = pos.clone().normalize();
    const worldUp = new THREE.Vector3(0, 1, 0);
    const east = new THREE.Vector3().crossVectors(worldUp, normal).normalize();
    const north = new THREE.Vector3().crossVectors(normal, east).normalize();
    const forward = north.clone().multiplyScalar(Math.cos(heading)).add(east.clone().multiplyScalar(Math.sin(heading)));
    return { normal: normal, east: east, north: north, forward: forward };
  }

  function lookFrom(pos, heading, pitch, normal, forward) {
    const aimed = forward
      .clone()
      .multiplyScalar(Math.cos(pitch))
      .add(normal.clone().multiplyScalar(Math.sin(pitch)));
    camera.up.copy(normal);
    camera.position.copy(pos);
    camera.lookAt(pos.clone().add(aimed));
  }

  function planeDistance() {
    const here = headingOffset(player.lon, player.lat, 0, 0);
    const craft = headingOffset(planeLon, planeLat, 0, 0);
    const east = (craft.lon - here.lon) * Math.PI / 180 * Math.max(0.25, Math.cos((player.lat * Math.PI) / 180));
    const north = ((craft.lat - here.lat) * Math.PI) / 180;
    return Math.hypot(east, north);
  }

  function respawn() {
    player.mode = "foot";
    player.speed = 0;
    player.throttle = 0.2;
    player.climb = 0;
    player.altitude = 0;
    player.pitch = -0.08;
    const side = headingOffset(runway.lon, runway.lat, runway.heading - 90, 0.007);
    player.lon = side.lon;
    player.lat = side.lat;
    player.yaw = (runway.heading * Math.PI) / 180;
    planeLon = runway.lon;
    planeLat = runway.lat;
    planeHeading = player.yaw;
  }

  function interact() {
    if (player.mode === "foot" && planeDistance() < 0.06) {
      player.mode = "plane";
      player.lon = planeLon;
      player.lat = planeLat;
      player.yaw = planeHeading;
      player.speed = 0.02;
      player.throttle = 0.35;
      player.altitude = 0.001;
      return;
    }
    if (player.mode === "plane" && player.altitude < 0.008 && player.speed < 0.045 && onLand(player.lon, player.lat)) {
      planeLon = player.lon;
      planeLat = player.lat;
      planeHeading = player.yaw;
      const side = headingOffset(player.lon, player.lat, (player.yaw * 180) / Math.PI - 90, 0.007);
      player.mode = "foot";
      player.lon = side.lon;
      player.lat = side.lat;
      player.speed = 0;
      player.altitude = 0;
      player.pitch = -0.08;
    }
  }

  function sim(dt) {
    if (!mapFocused || editing) return;
    if (player.mode === "foot") {
      let east = 0;
      let north = 0;
      const yaw = player.yaw;
      if (keys.has("KeyW") || keys.has("ArrowUp")) {
        north += Math.cos(yaw);
        east += Math.sin(yaw);
      }
      if (keys.has("KeyS") || keys.has("ArrowDown")) {
        north -= Math.cos(yaw);
        east -= Math.sin(yaw);
      }
      if (keys.has("KeyA") || keys.has("ArrowLeft")) {
        north += Math.sin(yaw);
        east -= Math.cos(yaw);
      }
      if (keys.has("KeyD") || keys.has("ArrowRight")) {
        north -= Math.sin(yaw);
        east += Math.cos(yaw);
      }
      const length = Math.hypot(east, north);
      if (length > 0) {
        const step = (0.02 * dt) / length;
        const next = offsetLonLat(player.lon, player.lat, east * step, north * step);
        if (onLand(next.lon, next.lat)) {
          player.lon = next.lon;
          player.lat = next.lat;
        }
      }
      player.speed = length > 0 ? 0.02 : 0;
      return;
    }
    if (keys.has("KeyW")) player.throttle = Math.min(1, player.throttle + dt * 0.4);
    if (keys.has("KeyS")) player.throttle = Math.max(0, player.throttle - dt * 0.55);
    if (keys.has("KeyA")) player.yaw -= dt * 0.85;
    if (keys.has("KeyD")) player.yaw += dt * 0.85;
    const climb = (keys.has("Space") ? 1 : 0) - (keys.has("ControlLeft") || keys.has("ControlRight") ? 1 : 0);
    player.climb += (climb * 0.7 - player.climb) * Math.min(1, dt * 3);
    const boost = keys.has("ShiftLeft") || keys.has("ShiftRight") ? 2.1 : 1;
    const target = player.throttle * 0.18 * boost;
    player.speed += (target - player.speed) * Math.min(1, dt * 1.4);
    const next = offsetLonLat(player.lon, player.lat, Math.sin(player.yaw) * player.speed * dt, Math.cos(player.yaw) * player.speed * dt);
    player.lon = next.lon;
    player.lat = next.lat;
    player.altitude += player.climb * Math.max(0.04, player.speed) * dt * 0.55;
    const ground = onLand(player.lon, player.lat) ? heightAt(player.lon, player.lat) * reliefScale : 0;
    if (player.altitude < 0.0008) {
      if (player.speed > 0.11) {
        respawn();
        return;
      }
      player.altitude = 0.0008;
      player.speed *= 0.55;
      player.climb = 0;
    }
    if (!onLand(player.lon, player.lat) && player.altitude < 0.004 && player.speed > 0.08) respawn();
    void ground;
  }

  function aim() {
    const heading = player.mode === "plane" ? player.yaw : player.yaw;
    if (player.mode === "plane") {
      planeLon = player.lon;
      planeLat = player.lat;
      planeHeading = player.yaw;
      const frameNow = placeObject(plane, player.lon, player.lat, heading, 0.0012 + player.altitude);
      if (plane.userData.prop) plane.userData.prop.rotation.z += player.speed * 40;
      const seat = frameNow.pos
        .clone()
        .add(frameNow.normal.clone().multiplyScalar(0.0016))
        .add(frameNow.forward.clone().multiplyScalar(-0.0004));
      lookFrom(seat, heading, player.pitch + player.climb * 0.35 - 0.35, frameNow.normal, frameNow.forward);
      return;
    }
    placeObject(plane, planeLon, planeLat, planeHeading, 0.0012);
    const eye = placeObject(eyeAnchor, player.lon, player.lat, heading, 0.0034);
    lookFrom(eye.pos, heading, player.pitch, eye.normal, eye.forward);
  }

  function hud() {
    const groundRadius = 1 + (onLand(player.lon, player.lat) ? heightAt(player.lon, player.lat) * reliefScale : 0);
    const eyeRadius = groundRadius + 0.0034 + (player.mode === "plane" ? player.altitude : 0);
    const meters = Math.max(0, (eyeRadius - groundRadius) / 0.0034 * 1.7);
    const kmh = (player.speed / 0.0034) * 1.7 * 3.6;
    if (readout) readout.textContent = Math.round(meters) + " m   " + Math.round(kmh) + " km/h";
    if (hint) {
      hint.textContent = player.mode === "plane"
        ? "W/S throttle · A/D turn · Shift boost · Space/Ctrl climb · E exit"
        : "Click to look · WASD walk · Esc releases mouse";
    }
    const nearPlane = player.mode === "foot" && planeDistance() < 0.06;
    const canLeave = player.mode === "plane" && player.altitude < 0.008 && player.speed < 0.045 && onLand(player.lon, player.lat);
    if (prompt) {
      prompt.hidden = !(nearPlane || canLeave);
      prompt.textContent = nearPlane ? "Press E to fly" : "Press E to get out";
    }
  }

  function projectMarkers() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    for (const place of hooks.places.places || []) {
      const point = surfacePoint(place);
      const cone = markerMesh.get(place.id);
      if (cone) {
        cone.position.copy(point);
        cone.lookAt(point.clone().multiplyScalar(1.4));
        cone.rotateX(Math.PI / 2);
      }
      const pin = dom.get(place.id);
      if (!pin) continue;
      const ndc = point.clone().project(camera);
      const facing = point.clone().sub(camera.position).dot(forward) > 0;
      const inside = ndc.x > -1.05 && ndc.x < 1.05 && ndc.y > -1.05 && ndc.y < 1.05;
      pin.hidden = !(facing && inside);
      if (pin.hidden) continue;
      pin.style.left = (ndc.x * 0.5 + 0.5) * width + "px";
      pin.style.top = (-ndc.y * 0.5 + 0.5) * height + "px";
    }
  }

  let last = performance.now();
  function frameStep(now) {
    if (!running) return;
    requestAnimationFrame(frameStep);
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    if (hooks.isVisible && !hooks.isVisible()) return;
    resize();
    sim(dt);
    placeObject(runwayMesh, runway.lon, runway.lat, (runway.heading * Math.PI) / 180, 0.0005);
    aim();
    hud();
    renderer.render(scene, camera);
    projectMarkers();
  }

  function focusMap(event) {
    if (event && event.target && event.target.closest && event.target.closest("button, a, input, textarea")) return;
    mapFocused = true;
    if (!editing) {
      try {
        const lock = canvas.requestPointerLock();
        if (lock && lock.catch) lock.catch(function () {});
      } catch (error) {}
    }
  }

  mapView.addEventListener("pointerdown", function (event) {
    if (editing && event.target === canvas) {
      if (selectedPlace) movePlace(selectedPlace, event.clientX, event.clientY);
      return;
    }
    focusMap(event);
  });
  document.addEventListener("pointerlockchange", function () {
    if (document.pointerLockElement !== canvas) player.pitch = Math.max(-0.4, Math.min(0.6, player.pitch));
  });
  document.addEventListener("mousemove", function (event) {
    if (document.pointerLockElement !== canvas) return;
    player.yaw += event.movementX * 0.0022;
    player.pitch -= event.movementY * 0.002;
    player.pitch = Math.max(-1.15, Math.min(1.15, player.pitch));
  });
  document.addEventListener("keydown", function (event) {
    if (!mapFocused || editing) return;
    if (event.target && event.target.closest && event.target.closest("input, textarea")) return;
    if (event.repeat && event.code === "KeyE") return;
    if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].indexOf(event.code) >= 0) event.preventDefault();
    keys.add(event.code);
    if (event.code === "KeyE" && !event.repeat) interact();
  });
  document.addEventListener("keyup", function (event) {
    keys.delete(event.code);
  });
  document.addEventListener("pointerdown", function (event) {
    if (!mapView.contains(event.target)) {
      mapFocused = false;
      keys.clear();
      if (document.pointerLockElement) document.exitPointerLock();
    }
  });

  rebuildMarkers();
  requestAnimationFrame(frameStep);

  return {
    setEditing(value) {
      editing = value;
      markers.classList.toggle("editing", value);
      keys.clear();
      if (value && document.pointerLockElement) document.exitPointerLock();
    },
    exportJson() {
      return JSON.stringify({ places: hooks.places.places, sceneTargets: hooks.places.sceneTargets }, null, 2) + "\n";
    },
    resize: resize,
    stop() {
      running = false;
    },
  };
}
