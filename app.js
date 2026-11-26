"use strict";

const LIVE_SOCKET = "ws://127.0.0.1:47632/";
const params = new URLSearchParams(location.search);
const preferLive = params.get("live") === "1" || (location.hostname === "127.0.0.1" && params.get("preview") !== "1");

const titleEl = document.querySelector("#title");
const connection = document.querySelector("#connection");
const revealButton = document.querySelector("#reveal-all");
const playButton = document.querySelector("#play");
const scrub = document.querySelector("#scrub");
const markers = document.querySelector("#markers");
const clock = document.querySelector("#clock");
const mapView = document.querySelector("#map-view");
const detail = document.querySelector("#detail");
const detailBody = document.querySelector("#detail-body");
const assetRow = document.querySelector("#assets");
const onscreenRow = document.querySelector("#onscreen");
const arrowLine = document.querySelector("#arrow-line");
const offmap = document.querySelector("#offmap");
const insetsEl = document.querySelector("#insets");
const worldPanel = document.querySelector("#world-panel");
const worldMap = document.querySelector("#world-map");
const worldPins = document.querySelector("#world-pins");
const sceneRing = document.querySelector("#scene-ring");
const mapSource = document.querySelector("#map-source");
const spoilerDialog = document.querySelector("#spoiler-dialog");

const FALLBACK_COLOR = {
  aang: "#e6b15a",
  katara: "#79b4c8",
  sokka: "#7f93a8",
  zuko: "#e07a4c",
  iroh: "#c4a15a",
};

let guide = null;
let revealCatalog = null;
let locations = null;
let revealAll = false;
let previewTime = 860;
let playing = false;
let live = null;
let liveSocket = null;
let selectedId = null;
let colorCache = {};
let hoverId = null;
let tracking = false;

function averageColor(img, id) {
  if (colorCache[id]) return colorCache[id];
  const canvas = document.createElement("canvas");
  const size = 24;
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  try {
    context.drawImage(img, 0, 0, size, size);
    const data = context.getImageData(0, 0, size, size).data;
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 48) continue;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n += 1;
    }
    if (!n) return FALLBACK_COLOR[id] || "#e7a15a";
    const color = "rgb(" + (r / n | 0) + "," + (g / n | 0) + "," + (b / n | 0) + ")";
    colorCache[id] = color;
    return color;
  } catch (error) {
    return FALLBACK_COLOR[id] || "#e7a15a";
  }
}

function positionAt(time) {
  const fromLive = liveSocket && liveSocket.readyState === WebSocket.OPEN && live;
  return {
    episodeKey: (fromLive && live.episodeKey) || (guide && guide.key) || "s01e01",
    seasonNumber: fromLive && live.season != null ? live.season : guide && guide.season,
    episodeNumber: fromLive && live.episode != null ? live.episode : guide && guide.episode,
    time: time,
  };
}

function activeTime() {
  if (live && liveSocket && liveSocket.readyState === WebSocket.OPEN && !playing) return live.currentTime || 0;
  return previewTime;
}

function framesFor(id) {
  return (locations && locations.assets && locations.assets[id]) || [];
}

function sceneView(name) {
  const scenes = (locations && locations.scenes) || {};
  const episode = (locations && locations.episode) || { cx: 50, cy: 50, zoom: 4 };
  const scene = scenes[name] || {};
  const cx = scene.cx != null ? scene.cx : episode.cx;
  const cy = scene.cy != null ? scene.cy : episode.cy;
  return {
    cx: cx,
    cy: cy,
    zoom: scene.zoom != null ? scene.zoom : episode.zoom,
    x: scene.x != null ? scene.x : cx,
    y: scene.y != null ? scene.y : cy,
  };
}

function spans(view) {
  const map = locations.worldMap;
  const aspect = (locations.frame && locations.frame.aspect) || 0.82;
  const spanX = 100 / view.zoom;
  const spanY = (spanX * (map.width / map.height)) / aspect;
  let top = view.cy - spanY / 2;
  const maxBottom = 87.5;
  if (top + spanY > maxBottom) top = maxBottom - spanY;
  if (top < 0) top = 0;
  return {
    spanX: spanX,
    spanY: spanY,
    left: view.cx - spanX / 2,
    top: top,
  };
}

function worldToView(x, y, view) {
  const box = spans(view);
  const px = ((x - box.left) / box.spanX) * 100;
  const py = ((y - box.top) / box.spanY) * 100;
  if (px < 0 || px > 100 || py < 0 || py > 100) return null;
  return { x: px, y: py };
}

function worldToInsetImage(x, y, inset) {
  const bounds = inset.world;
  if (x < bounds.x || y < bounds.y || x > bounds.x + bounds.w || y > bounds.y + bounds.h) return null;
  const across = (x - bounds.x) / bounds.w;
  const down = (y - bounds.y) / bounds.h;
  const content = inset.content || { x: 0, y: 0, w: 100, h: 100 };
  return { x: content.x + across * content.w, y: content.y + down * content.h };
}

function coverPoint(img, xPercent, yPercent) {
  const panel = img.getBoundingClientRect();
  const naturalW = img.naturalWidth || img.width;
  const naturalH = img.naturalHeight || img.height;
  if (!panel.width || !panel.height || !naturalW || !naturalH) return null;
  const scale = Math.max(panel.width / naturalW, panel.height / naturalH);
  const drawnW = naturalW * scale;
  const drawnH = naturalH * scale;
  const offsetX = (panel.width - drawnW) / 2;
  const offsetY = (panel.height - drawnH) / 2;
  const px = offsetX + (xPercent / 100) * drawnW;
  const py = offsetY + (yPercent / 100) * drawnH;
  if (px < 0 || py < 0 || px > panel.width || py > panel.height) return null;
  return { x: (px / panel.width) * 100, y: (py / panel.height) * 100 };
}

function applyWorldCrop(view) {
  const box = spans(view);
  worldPanel.style.aspectRatio = String((locations.frame && locations.frame.aspect) || 0.82);
  worldMap.style.width = (100 / box.spanX) * 100 + "%";
  worldMap.style.height = (100 / box.spanY) * 100 + "%";
  worldMap.style.left = (-box.left / box.spanX) * 100 + "%";
  worldMap.style.top = (-box.top / box.spanY) * 100 + "%";
}

function relevance(asset, time, place) {
  const spot = OnScreen.locationAt(framesFor(asset.id), time);
  let score = 0;
  if (spot) score += 40;
  if (spot && place) score += Math.max(0, 36 - Math.hypot(spot.x - place.x, spot.y - place.y));
  return score;
}

function makePin(asset, spot, surface) {
  const pin = document.createElement("button");
  pin.type = "button";
  pin.className = "pin " + (asset.type || "");
  pin.dataset.id = asset.id;
  pin.dataset.surface = surface;
  pin.style.left = spot.x + "%";
  pin.style.top = spot.y + "%";
  pin.title = asset.name;
  if (asset.imageUrl) {
    const img = document.createElement("img");
    img.alt = "";
    img.src = asset.imageUrl;
    pin.append(img);
  }
  pin.addEventListener("click", function () {
    selectedId = asset.id;
    render();
  });
  return pin;
}

function makeCard(asset, speaking) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "card" + (speaking ? " speaking" : "");
  card.dataset.id = asset.id;
  const img = document.createElement("img");
  img.alt = "";
  img.src = asset.imageUrl || "";
  img.addEventListener("load", function () {
    if (speaking) card.style.setProperty("--speak", averageColor(img, asset.id));
  });
  if (speaking) card.style.setProperty("--speak", FALLBACK_COLOR[asset.id] || "#e7a15a");
  const label = document.createElement("span");
  label.textContent = asset.name;
  card.append(img, label);
  card.addEventListener("click", function () {
    selectedId = asset.id;
    render();
  });
  card.addEventListener("mouseenter", function () {
    hoverId = asset.id;
    pointAt(card, asset.id);
    startTracking();
  });
  card.addEventListener("mouseleave", function () {
    if (hoverId === asset.id) hoverId = null;
    hideArrow();
  });
  return card;
}

function pinFor(id) {
  return (
    document.querySelector('.pin[data-id="' + id + '"][data-surface="inset"]') ||
    document.querySelector('.pin[data-id="' + id + '"]')
  );
}

function pointAt(card, id) {
  if (mapView.hidden) {
    hideArrow();
    return;
  }
  const rect = card.getBoundingClientRect();
  const pin = pinFor(id);
  if (!pin) {
    offmap.hidden = false;
    offmap.style.left = rect.left + rect.width / 2 + "px";
    offmap.style.top = rect.top - 6 + "px";
    arrowLine.setAttribute("x1", 0);
    arrowLine.setAttribute("y1", 0);
    arrowLine.setAttribute("x2", 0);
    arrowLine.setAttribute("y2", 0);
    return;
  }
  offmap.hidden = true;
  const pinRect = pin.getBoundingClientRect();
  arrowLine.setAttribute("x1", rect.left + rect.width / 2);
  arrowLine.setAttribute("y1", rect.top);
  arrowLine.setAttribute("x2", pinRect.left + pinRect.width / 2);
  arrowLine.setAttribute("y2", pinRect.top + pinRect.height / 2);
}

function hideArrow() {
  offmap.hidden = true;
  arrowLine.setAttribute("x1", 0);
  arrowLine.setAttribute("y1", 0);
  arrowLine.setAttribute("x2", 0);
  arrowLine.setAttribute("y2", 0);
}

function startTracking() {
  if (tracking) return;
  tracking = true;
  const step = function () {
    if (!hoverId) {
      tracking = false;
      return;
    }
    const card = document.querySelector('.card[data-id="' + hoverId + '"]');
    if (card) pointAt(card, hoverId);
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderDetail(asset) {
  detailBody.replaceChildren();
  const img = document.createElement("img");
  img.alt = "";
  img.src = asset.imageUrl || "";
  const heading = document.createElement("h3");
  heading.textContent = asset.name;
  const kind = document.createElement("p");
  kind.textContent = asset.type;
  const list = document.createElement("ul");
  for (const fact of asset.facts) {
    const item = document.createElement("li");
    item.textContent = fact.text;
    list.append(item);
  }
  detailBody.append(img, heading, kind, list);
  if (asset.sourceUrl) {
    const link = document.createElement("a");
    link.href = asset.sourceUrl;
    link.textContent = "Source: Avatar Wiki";
    detailBody.append(link);
  }
}

function ensureInsets() {
  if (insetsEl.childElementCount) return;
  for (const inset of locations.insets || []) {
    const panel = document.createElement("div");
    panel.className = "inset";
    panel.dataset.inset = inset.id;
    const img = document.createElement("img");
    img.className = "inset-img";
    img.alt = inset.title || "Inset map";
    img.src = inset.src;
    img.addEventListener("load", function () {
      render();
    });
    const ring = document.createElement("div");
    ring.className = "inset-ring";
    ring.hidden = true;
    const pins = document.createElement("div");
    pins.className = "inset-pins";
    const link = document.createElement("a");
    link.className = "source-link";
    link.href = inset.sourceUrl;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Source";
    panel.append(img, ring, pins, link);
    insetsEl.append(panel);
  }
}

function render() {
  if (!guide || !revealCatalog || !locations) return;
  const assetScroll = assetRow.scrollLeft;
  const screenScroll = onscreenRow.scrollLeft;
  const time = activeTime();
  const view = OnScreen.lookupAt(guide, time);
  const sceneName = view.scene && (view.scene.name || view.scene.summary);
  const camera = sceneView(sceneName || "");
  titleEl.textContent = guide.title || "The Boy in the Iceberg";
  clock.textContent = OnScreen.formatClock(time);
  scrub.max = String(Math.max(60, ...guide.scenes.map((scene) => scene.end || 0)));
  if (document.activeElement !== scrub) scrub.value = String(Math.round(time));
  const here = positionAt(time);
  const visible = OnScreen.getVisibleAssets(guide, revealCatalog, here, { revealAll });

  if (liveSocket && liveSocket.readyState === WebSocket.OPEN) {
    connection.textContent = live && live.episodeTitle ? "Live · " + live.episodeTitle : "Live";
  } else if (preferLive) {
    connection.textContent = "Preview (simulated playback) · socket closed";
  } else {
    connection.textContent = "Preview (simulated playback)";
  }
  revealButton.textContent = revealAll ? "Hide all" : "Reveal all";
  revealButton.setAttribute("aria-pressed", revealAll ? "true" : "false");
  playButton.textContent = playing ? "Pause" : "Play";
  playButton.classList.toggle("on", playing);

  markers.replaceChildren();
  const duration = Number(scrub.max) || 1;
  for (const scene of guide.scenes) {
    const mark = document.createElement("span");
    mark.className = "marker";
    mark.dataset.name = scene.name || scene.summary || "Scene";
    mark.style.left = (100 * (scene.start || 0)) / duration + "%";
    markers.append(mark);
  }

  const speakingIds = {};
  (view.speaking || []).forEach((person) => {
    speakingIds[person.id] = true;
  });
  const aroundIds = {};
  (view.present || []).concat(view.speaking || []).forEach((person) => {
    aroundIds[person.id] = true;
  });
  if (!Object.keys(aroundIds).length) {
    const covered = guide.scenes.filter((scene) => scene.start <= time).sort((a, b) => b.start - a.start)[0];
    ((covered && covered.characterIds) || []).forEach((id) => {
      aroundIds[id] = true;
    });
  }

  ensureInsets();
  worldMap.src = locations.worldMap.src;
  mapSource.href = locations.worldMap.sourceUrl;
  applyWorldCrop(camera);

  const focus = worldToView(camera.x, camera.y, camera);
  if (focus) {
    sceneRing.hidden = false;
    sceneRing.style.left = focus.x + "%";
    sceneRing.style.top = focus.y + "%";
  } else {
    sceneRing.hidden = true;
  }

  worldPins.replaceChildren();
  for (const inset of locations.insets || []) {
    const panel = insetsEl.querySelector('[data-inset="' + inset.id + '"]');
    if (!panel) continue;
    panel.querySelector(".inset-pins").replaceChildren();
    const ring = panel.querySelector(".inset-ring");
    const img = panel.querySelector(".inset-img");
    const onImage = worldToInsetImage(camera.x, camera.y, inset);
    const onPanel = onImage && coverPoint(img, onImage.x, onImage.y);
    if (onPanel) {
      ring.hidden = false;
      ring.style.left = onPanel.x + "%";
      ring.style.top = onPanel.y + "%";
    } else {
      ring.hidden = true;
    }
  }

  for (const asset of visible) {
    const spot = OnScreen.locationAt(framesFor(asset.id), time);
    if (!spot) continue;
    const onWorld = worldToView(spot.x, spot.y, camera);
    if (onWorld) worldPins.append(makePin(asset, onWorld, "world"));
    for (const inset of locations.insets || []) {
      const onImage = worldToInsetImage(spot.x, spot.y, inset);
      if (!onImage) continue;
      const panel = insetsEl.querySelector('[data-inset="' + inset.id + '"]');
      const img = panel && panel.querySelector(".inset-img");
      const onPanel = img && coverPoint(img, onImage.x, onImage.y);
      if (onPanel) panel.querySelector(".inset-pins").append(makePin(asset, onPanel, "inset"));
    }
  }

  if (selectedId) {
    const asset = visible.find((item) => item.id === selectedId);
    mapView.hidden = true;
    detail.hidden = false;
    if (asset) renderDetail(asset);
    else {
      selectedId = null;
      mapView.hidden = false;
      detail.hidden = true;
    }
  } else {
    mapView.hidden = false;
    detail.hidden = true;
  }

  const ranked = visible.slice().sort((a, b) => relevance(b, time, camera) - relevance(a, time, camera));
  const onScreen = ranked.filter((asset) => asset.type === "character" && (revealAll || aroundIds[asset.id]));
  const onScreenIds = {};
  onScreen.forEach((asset) => {
    onScreenIds[asset.id] = true;
  });
  const assetCards = ranked.filter((asset) => !onScreenIds[asset.id]);

  assetRow.replaceChildren();
  if (!assetCards.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No assets unlocked yet.";
    assetRow.append(empty);
  }
  for (const asset of assetCards) assetRow.append(makeCard(asset, false));

  onscreenRow.replaceChildren();
  if (!onScreen.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Nobody unlocked is on screen.";
    onscreenRow.append(empty);
  }
  for (const asset of onScreen) onscreenRow.append(makeCard(asset, !!speakingIds[asset.id]));
  assetRow.scrollLeft = assetScroll;
  onscreenRow.scrollLeft = screenScroll;
}

function connectLive() {
  if (!preferLive) return;
  let socket;
  try {
    socket = new WebSocket(LIVE_SOCKET);
  } catch (error) {
    connection.textContent = "Preview (simulated playback) · socket closed";
    return;
  }
  liveSocket = socket;
  socket.addEventListener("open", function () {
    connection.textContent = "Live";
    socket.send(JSON.stringify({ type: "hello", version: 1, role: "companion" }));
  });
  socket.addEventListener("message", function (event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      return;
    }
    if (message.type === "playback") {
      live = message;
      if (!playing) previewTime = message.currentTime || previewTime;
      render();
    }
    if (message.type === "database" && message.database && OnScreen.isDatabase(message.database)) {
      guide = message.database;
      render();
    }
  });
  socket.addEventListener("close", function () {
    connection.textContent = "Preview (simulated playback) · socket closed";
    setTimeout(connectLive, 1500);
  });
}

revealButton.addEventListener("click", function () {
  if (revealAll) {
    revealAll = false;
    render();
    return;
  }
  spoilerDialog.showModal();
});

spoilerDialog.addEventListener("close", function () {
  if (spoilerDialog.returnValue === "confirm") {
    revealAll = true;
    render();
  }
});

playButton.addEventListener("click", function () {
  playing = !playing;
  if (playing) {
    let last = 0;
    const step = function (now) {
      if (!playing) return;
      if (last) previewTime += (now - last) / 1000;
      last = now;
      const end = Number(scrub.max) || 1365;
      if (previewTime >= end) {
        previewTime = end;
        playing = false;
      }
      render();
      if (playing) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  } else {
    render();
  }
});

scrub.addEventListener("input", function () {
  playing = false;
  previewTime = Number(scrub.value);
  render();
});

document.querySelector("#back").addEventListener("click", function () {
  selectedId = null;
  hoverId = null;
  hideArrow();
  render();
});

assetRow.addEventListener("scroll", function () {
  if (!hoverId) return;
  const card = document.querySelector('.card[data-id="' + hoverId + '"]');
  if (card) pointAt(card, hoverId);
});
onscreenRow.addEventListener("scroll", function () {
  if (!hoverId) return;
  const card = document.querySelector('.card[data-id="' + hoverId + '"]');
  if (card) pointAt(card, hoverId);
});
window.addEventListener("resize", function () {
  render();
});

Promise.all([
  fetch("data/guide.json").then((response) => response.json()),
  fetch("data/reveal.json").then((response) => response.json()),
  fetch("data/locations.json").then((response) => response.json()),
]).then(function (loaded) {
  guide = loaded[0];
  revealCatalog = loaded[1];
  locations = loaded[2];
  render();
  connectLive();
}).catch(function (error) {
  connection.textContent = "Could not load the bundled guide";
  console.error(error);
});
