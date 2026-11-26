async function loadThree() {
  try {
    return await import("./vendor/three.module.js");
  } catch (error) {
    return await import("https://unpkg.com/three@0.170.0/build/three.module.js");
  }
}

const BIOMES = [
  [0.09, 0.2, 0.4],
  [0.78, 0.88, 0.92],
  [0.55, 0.47, 0.3],
  [0.42, 0.45, 0.5],
  [0.2, 0.38, 0.24],
  [0.74, 0.58, 0.3],
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
  const relief = 0.12;

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
    return lonLatToVector(THREE, geo.lon, geo.lat, 1 + cellHeight(col, row) * relief);
  }

  const positions = [];
  const colors = [];
  for (let row = 0; row < rows - 1; row++) {
    for (let col = 0; col < cols - 1; col++) {
      const biome = world.biomes[row * cols + col];
      const tint = BIOMES[biome] || BIOMES[0];
      const shade = 0.9 + ((col * 3 + row) % 5) * 0.025;
      const corners = [corner(col, row), corner(col + 1, row), corner(col + 1, row + 1), corner(col, row + 1)];
      const triangles = [
        [0, 1, 2],
        [0, 2, 3],
      ];
      for (const triangle of triangles) {
        for (const index of triangle) {
          positions.push(corners[index].x, corners[index].y, corners[index].z);
          colors.push(tint[0] * shade, tint[1] * shade, tint[2] * shade);
        }
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  const terrain = new THREE.Mesh(
    geometry,
    new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })
  );

  const coast = new THREE.Group();
  for (const ring of world.coastlines || []) {
    const linePoints = ring.points.map((point) => {
      const mapX = crop.x + (point.x / (cols - 1)) * crop.w;
      const mapY = crop.y + (point.y / (rows - 1)) * crop.h;
      const geo = toLonLat(mapX, mapY, frame);
      return lonLatToVector(THREE, geo.lon, geo.lat, 1.02);
    });
    if (linePoints.length > 2) linePoints.push(linePoints[0]);
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(linePoints),
      new THREE.LineBasicMaterial({ color: 0xf2f7fb })
    );
    coast.add(line);
  }

  const markerGroup = new THREE.Group();
  const markerMesh = new Map();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101a2e);
  scene.add(terrain, coast, markerGroup);
  scene.add(new THREE.HemisphereLight(0xd5e4f5, 0x1b2838, 0.95));
  const sun = new THREE.DirectionalLight(0xfff1dc, 1.25);
  sun.position.set(-2, 3, 2);
  scene.add(sun);

  const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 20);
  const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const markers = hooks.markers;
  const dom = new Map();
  const focus = { lon: (world.bounds.lon[0] + world.bounds.lon[1]) / 2, lat: (world.bounds.lat[0] + world.bounds.lat[1]) / 2, distance: 1.05, yaw: 0.35, pitch: 0.78 };
  const goal = Object.assign({}, focus);
  let editing = false;
  let dragging = null;
  let orbiting = false;
  let lastX = 0;
  let lastY = 0;
  let running = true;

  function placeById(id) {
    return (hooks.places.places || []).find((place) => place.id === id);
  }

  function surfacePoint(place) {
    const height = heightAt(place.lon, place.lat);
    return lonLatToVector(THREE, place.lon, place.lat, 1 + height * relief + 0.025);
  }

  function rebuildMarkers() {
    markerGroup.clear();
    markerMesh.clear();
    markers.replaceChildren();
    dom.clear();
    for (const place of hooks.places.places || []) {
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(0.012, 0.045, 5),
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
        if (editing) {
          event.preventDefault();
          return;
        }
        if (place.assetId && hooks.onMarkerClick) hooks.onMarkerClick(place.assetId);
      });
      pin.addEventListener("pointerdown", function (event) {
        if (!editing) return;
        dragging = place.id;
        pin.setPointerCapture(event.pointerId);
        event.stopPropagation();
      });
      pin.addEventListener("pointermove", function (event) {
        if (dragging !== place.id) return;
        movePlace(place, event);
      });
      pin.addEventListener("pointerup", function () {
        dragging = null;
      });
      markers.append(pin);
      dom.set(place.id, pin);
    }
  }

  function movePlace(place, event) {
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObject(terrain, false)[0];
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

  function aim() {
    focus.lon += (goal.lon - focus.lon) * 0.08;
    focus.lat += (goal.lat - focus.lat) * 0.08;
    focus.distance += (goal.distance - focus.distance) * 0.08;
    focus.yaw += (goal.yaw - focus.yaw) * 0.12;
    focus.pitch += (goal.pitch - focus.pitch) * 0.12;
    const target = lonLatToVector(THREE, focus.lon, focus.lat, 1);
    const normal = target.clone().normalize();
    const worldUp = Math.abs(normal.y) > 0.98 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const east = new THREE.Vector3().crossVectors(worldUp, normal).normalize();
    const north = new THREE.Vector3().crossVectors(normal, east).normalize();
    const pitch = focus.pitch;
    const offset = normal
      .clone()
      .multiplyScalar(Math.cos(pitch) * focus.distance)
      .add(east.clone().multiplyScalar(Math.sin(pitch) * Math.sin(focus.yaw) * focus.distance))
      .add(north.clone().multiplyScalar(Math.sin(pitch) * Math.cos(focus.yaw) * focus.distance));
    camera.position.copy(target).add(offset);
    camera.up.copy(north);
    camera.lookAt(target);
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
        cone.lookAt(point.clone().multiplyScalar(1.2));
        cone.rotateX(Math.PI / 2);
      }
      const pin = dom.get(place.id);
      if (!pin) continue;
      const ndc = point.clone().project(camera);
      const facing = point.clone().sub(camera.position).dot(forward) > 0;
      const inside = ndc.x > -1.05 && ndc.x < 1.05 && ndc.y > -1.05 && ndc.y < 1.05;
      if (!facing || !inside) {
        pin.hidden = true;
        continue;
      }
      pin.hidden = false;
      pin.style.left = (ndc.x * 0.5 + 0.5) * width + "px";
      pin.style.top = (-ndc.y * 0.5 + 0.5) * height + "px";
    }
  }

  function frameStep() {
    if (!running) return;
    requestAnimationFrame(frameStep);
    if (hooks.isVisible && !hooks.isVisible()) return;
    resize();
    aim();
    renderer.render(scene, camera);
    projectMarkers();
  }

  canvas.addEventListener("pointerdown", function (event) {
    if (editing && event.target !== canvas) return;
    orbiting = true;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", function (event) {
    if (!orbiting) return;
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    goal.yaw += dx * 0.005;
    focus.yaw = goal.yaw;
    goal.pitch = Math.max(0.28, Math.min(1.25, goal.pitch + dy * 0.004));
    focus.pitch = goal.pitch;
  });
  canvas.addEventListener("pointerup", function () {
    orbiting = false;
  });
  canvas.addEventListener(
    "wheel",
    function (event) {
      event.preventDefault();
      goal.distance = Math.max(0.55, Math.min(3.2, goal.distance * (event.deltaY > 0 ? 1.08 : 0.92)));
    },
    { passive: false }
  );

  rebuildMarkers();
  frameStep();

  return {
    focusPlace(placeId, distance) {
      const place = placeById(placeId);
      if (!place) return;
      goal.lon = place.lon;
      goal.lat = place.lat;
      if (distance) goal.distance = distance;
    },
    setEditing(value) {
      editing = value;
      markers.classList.toggle("editing", value);
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
