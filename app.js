import { mountGlobe } from "./globe.js";

const LIVE_SOCKET = "ws://127.0.0.1:47632/";
const params = new URLSearchParams(location.search);
const preferLive = params.get("live") === "1" || (location.hostname === "127.0.0.1" && params.get("preview") !== "1");

const titleEl = document.querySelector("#title");
const connection = document.querySelector("#connection");
const revealButton = document.querySelector("#reveal-all");
const playButton = document.querySelector("#play");
const scrub = document.querySelector("#scrub");
const sceneMarks = document.querySelector("#scene-markers");
const markerLayer = document.querySelector("#marker-layer");
const clock = document.querySelector("#clock");
const mapView = document.querySelector("#map-view");
const detail = document.querySelector("#detail");
const detailBody = document.querySelector("#detail-body");
const assetRow = document.querySelector("#assets");
const onscreenRow = document.querySelector("#onscreen");
const arrowLine = document.querySelector("#arrow-line");
const offmap = document.querySelector("#offmap");
const editButton = document.querySelector("#edit-places");
const copyButton = document.querySelector("#copy-places");
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
let placeBook = null;
let globe = null;
let revealAll = false;
let editing = false;
let previewTime = 820;
let playing = false;
let live = null;
let liveSocket = null;
let selectedId = null;
let colorCache = {};
let hoverId = null;
let tracking = false;
let lastScene = null;

function averageColor(img, id) {
  if (colorCache[id]) return colorCache[id];
  const canvas = document.createElement("canvas");
  canvas.width = 24;
  canvas.height = 24;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  try {
    context.drawImage(img, 0, 0, 24, 24);
    const data = context.getImageData(0, 0, 24, 24).data;
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

function relevance(asset) {
  const placed = placeBook && placeBook.places.some((place) => place.assetId === asset.id);
  return placed ? 1 : 0;
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
  return document.querySelector('#marker-layer .pin[data-id="' + id + '"]:not([hidden])');
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

function render() {
  if (!guide || !revealCatalog) return;
  const assetScroll = assetRow.scrollLeft;
  const screenScroll = onscreenRow.scrollLeft;
  const time = activeTime();
  const view = OnScreen.lookupAt(guide, time);
  const sceneName = (view.scene && (view.scene.name || view.scene.summary)) || "";
  titleEl.textContent = guide.title || "The Boy in the Iceberg";
  clock.textContent = OnScreen.formatClock(time);
  scrub.max = String(Math.max(60, ...guide.scenes.map((scene) => scene.end || 0)));
  if (document.activeElement !== scrub) scrub.value = String(Math.round(time));
  const visible = OnScreen.getVisibleAssets(guide, revealCatalog, positionAt(time), { revealAll });

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

  sceneMarks.replaceChildren();
  const duration = Number(scrub.max) || 1;
  for (const scene of guide.scenes) {
    const mark = document.createElement("span");
    mark.className = "marker";
    mark.dataset.name = scene.name || scene.summary || "Scene";
    mark.style.left = (100 * (scene.start || 0)) / duration + "%";
    sceneMarks.append(mark);
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

  const ranked = visible.slice().sort((a, b) => relevance(b) - relevance(a));
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
  if (globe) globe.resize();
});

editButton.addEventListener("click", function () {
  editing = !editing;
  editButton.classList.toggle("on", editing);
  editButton.textContent = editing ? "Done" : "Edit places";
  copyButton.hidden = !editing;
  if (globe) globe.setEditing(editing);
});

copyButton.addEventListener("click", async function () {
  if (!globe) return;
  const json = globe.exportJson();
  try {
    await navigator.clipboard.writeText(json);
    copyButton.textContent = "Copied";
  } catch (error) {
    const area = document.createElement("textarea");
    area.value = json;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
    copyButton.textContent = "Copied";
  }
  setTimeout(function () {
    copyButton.textContent = "Copy JSON";
  }, 1200);
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
  if (globe) globe.resize();
});

Promise.all([
  fetch("data/guide.json").then((response) => response.json()),
  fetch("data/reveal.json").then((response) => response.json()),
  fetch("data/world/south-pole.json").then((response) => response.json()),
  fetch("data/world/places.json").then((response) => response.json()),
]).then(async function (loaded) {
  guide = loaded[0];
  revealCatalog = loaded[1];
  const world = loaded[2];
  placeBook = loaded[3];
  try {
    globe = await mountGlobe(document.querySelector("#globe"), world, {
      places: placeBook,
      markers: markerLayer,
      mapView: mapView,
      isVisible: function () {
        return !mapView.hidden && !document.hidden;
      },
      onMarkerClick: function (assetId) {
        selectedId = assetId;
        render();
      },
    });
  } catch (error) {
    connection.textContent = "Could not start the globe";
    console.error(error);
  }
  render();
  connectLive();
}).catch(function (error) {
  connection.textContent = "Could not load the bundled guide";
  console.error(error);
});
