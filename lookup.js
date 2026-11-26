"use strict";

/**
 * timestamp + episode database -> the scene, who is speaking, and who else
 * is around that moment.
 *
 * Line databases (built by collection mode) use the timed lines.
 * The shipped approximate guide has scenes only: people listed on the scene,
 * and a narrator when the guide says the line is voiceover.
 * Playback rate is not an input. The same timestamp is the same frame at any speed.
 */
(function (root) {
  const OS = root.OnScreen || (root.OnScreen = {});

  function formatClock(seconds) {
    let value = Number(seconds);
    if (!Number.isFinite(value) || value < 0) value = 0;
    const whole = Math.floor(value);
    const minutes = Math.floor(whole / 60);
    const secs = whole % 60;
    return minutes + ":" + String(secs).padStart(2, "0");
  }

  function isDatabase(data) {
    return !!(data && data.format === "whos-here-database" && data.formatVersion === 1 && Array.isArray(data.scenes));
  }

  function decorate(database, id, narration) {
    const info = (database.characters && database.characters[id]) || {};
    return {
      id,
      name: info.name || id,
      description: info.description || "Appears in this episode.",
      element: info.element || "none",
      narration: !!narration,
    };
  }

  function publicScene(scene) {
    if (!scene) return null;
    return {
      id: scene.id,
      episodeKey: scene.episodeKey || null,
      name: scene.name || scene.summary || "",
      summary: scene.summary || "",
      description: scene.description || "",
      start: scene.start,
      end: scene.end,
    };
  }

  function uniquePeople(people) {
    const out = [];
    const seen = {};
    for (const person of people) {
      if (!person || seen[person.id]) continue;
      seen[person.id] = true;
      out.push(person);
    }
    return out;
  }

  function lookupAt(database, timeSeconds) {
    const time = Number(timeSeconds);
    const t = Number.isFinite(time) && time > 0 ? time : 0;
    const empty = {
      time: t,
      found: false,
      precision: database && database.precision ? database.precision : null,
      precisionNote: database && database.precisionNote ? database.precisionNote : "",
      held: false,
      scene: null,
      speaking: [],
      present: [],
      line: null,
    };
    if (!isDatabase(database)) return empty;

    const scene =
      (database.scenes || []).find((item) => item.start != null && item.start <= t && t < item.end) || null;

    const lines = database.lines || [];
    if (!lines.length) {
      if (!scene) return empty;
      const roles = scene.roles || {};
      const speaking = [];
      const present = [];
      for (const id of scene.characterIds || []) {
        const person = decorate(database, id, roles[id] === "voiceover");
        if (roles[id] === "voiceover") speaking.push(person);
        present.push(person);
      }
      return {
        time: t,
        found: present.length > 0 || speaking.length > 0,
        precision: database.precision,
        precisionNote: database.precisionNote || "",
        held: false,
        scene: publicScene(scene),
        speaking,
        present,
        line: null,
      };
    }

    const covering = lines.filter((line) => line.start <= t && t < line.end);
    covering.sort((a, b) => b.start - a.start);
    let held = false;
    let active = covering;
    if (!active.length) {
      let nearest = null;
      for (const line of lines) {
        if (line.end <= t && t - line.end <= 0.75 && (!nearest || line.end > nearest.end)) nearest = line;
      }
      if (nearest && (!scene || nearest.sceneId === scene.id)) {
        active = [nearest];
        held = true;
      }
    }

    const speaking = uniquePeople(
      active.map((line) => decorate(database, line.speakerId, line.narration))
    );

    const windowLines = lines.filter((line) => {
      if (scene && line.sceneId !== scene.id) return false;
      return line.end > t - 12 && line.start < t + 3;
    });
    const present = [];
    for (const line of windowLines) {
      if (line.speakerId && !line.narration) present.push(decorate(database, line.speakerId, false));
      for (const id of line.namedIds || []) present.push(decorate(database, id, false));
    }
    for (const person of speaking) {
      if (!person.narration) present.push(person);
    }

    const current = active[0] || null;
    return {
      time: t,
      found: !!(scene || current || present.length),
      precision: database.precision,
      precisionNote: database.precisionNote || "",
      held,
      scene: publicScene(scene || (current ? (database.scenes || []).find((item) => item.id === current.sceneId) : null)),
      speaking,
      present: uniquePeople(present).slice(0, 8),
      line: current
        ? {
            transcriptIndex: current.transcriptIndex,
            text: current.text || "",
            speakerId: current.speakerId || null,
            start: current.start,
            end: current.end,
            narration: !!current.narration,
            beat: current.beat || "",
          }
        : null,
    };
  }

  function episodeRank(position) {
    if (!position || position.seasonNumber == null || position.episodeNumber == null) return null;
    const season = Number(position.seasonNumber);
    const episode = Number(position.episodeNumber);
    if (!Number.isFinite(season) || !Number.isFinite(episode)) return null;
    return season * 1000 + episode;
  }

  function resolveUnlock(unlock, database) {
    const point = unlock || {};
    if (point.atEpisodeEnd) {
      return { time: Number.POSITIVE_INFINITY, exact: false, confidence: point.confidence || "episode-end" };
    }
    const lines = (database && database.lines) || [];
    if (point.transcriptIndex != null && (!database || !database.key || database.key === point.episodeKey)) {
      const later = lines
        .filter((line) => line.transcriptIndex >= point.transcriptIndex && Number.isFinite(line.start))
        .sort((a, b) => a.transcriptIndex - b.transcriptIndex || a.start - b.start);
      if (later.length) {
        return { time: later[0].start, exact: true, confidence: "transcript-anchor" };
      }
    }
    if (Number.isFinite(point.fallbackTime)) {
      return { time: point.fallbackTime, exact: false, confidence: point.confidence || "approximate-fallback" };
    }
    return { time: Number.POSITIVE_INFINITY, exact: false, confidence: point.confidence || "unplaced" };
  }

  function factVisible(fact, position, resolved, revealAll) {
    if (revealAll) return true;
    const unlock = fact.unlock || {};
    const factRank = episodeRank(unlock);
    const hereRank = episodeRank(position);
    if (factRank == null || hereRank == null) {
      if (unlock.episodeKey && position && position.episodeKey && unlock.episodeKey === position.episodeKey) {
        return resolved.time <= (Number(position.time) || 0);
      }
      return false;
    }
    if (factRank < hereRank) return true;
    if (factRank > hereRank) return false;
    return resolved.time <= (Number(position && position.time) || 0);
  }

  function getVisibleAssets(database, catalog, position, options) {
    const revealAll = !!(options && options.revealAll);
    const here = position || {};
    const assets = (catalog && catalog.assets) || [];
    const facts = (catalog && catalog.facts) || [];
    const visible = [];
    for (const asset of assets) {
      const unlocked = [];
      for (const fact of facts) {
        if (!fact || fact.assetId !== asset.id) continue;
        const resolved = resolveUnlock(fact.unlock, database);
        if (!factVisible(fact, here, resolved, revealAll)) continue;
        unlocked.push({
          id: fact.id,
          text: fact.text,
          sourceUrl: fact.sourceUrl || asset.sourceUrl || null,
          confidence: resolved.confidence,
          derived: (fact.unlock && fact.unlock.derived) || "",
          episodeKey: fact.unlock && fact.unlock.episodeKey,
          seasonNumber: fact.unlock && fact.unlock.seasonNumber,
          episodeNumber: fact.unlock && fact.unlock.episodeNumber,
          time: Number.isFinite(resolved.time) ? resolved.time : null,
          exact: resolved.exact,
        });
      }
      if (!unlocked.length) continue;
      unlocked.sort((a, b) => {
        const left = episodeRank(a);
        const right = episodeRank(b);
        if (left != null && right != null && left !== right) return right - left;
        const timeDelta = (b.time == null ? Infinity : b.time) - (a.time == null ? Infinity : a.time);
        return timeDelta;
      });
      const newest = unlocked[0];
      visible.push({
        id: asset.id,
        name: asset.name,
        type: asset.type,
        imageUrl: asset.imageUrl || null,
        sourceUrl: asset.sourceUrl || null,
        facts: unlocked,
        newest,
      });
    }
    visible.sort((a, b) => {
      const left = episodeRank(a.newest);
      const right = episodeRank(b.newest);
      if (left != null && right != null && left !== right) return right - left;
      return (b.newest.time == null ? Infinity : b.newest.time) - (a.newest.time == null ? Infinity : a.newest.time);
    });
    return visible;
  }

  function locationAt(frames, time) {
    if (!frames || !frames.length) return null;
    const sorted = frames.slice().sort((a, b) => a.t - b.t);
    if (time < sorted[0].t) return null;
    let previous = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      const next = sorted[i];
      if (time < next.t) {
        const span = next.t - previous.t || 1;
        const mix = (time - previous.t) / span;
        return {
          x: previous.x + (next.x - previous.x) * mix,
          y: previous.y + (next.y - previous.y) * mix,
        };
      }
      previous = next;
    }
    return { x: previous.x, y: previous.y };
  }

  OS.formatClock = formatClock;
  OS.locationAt = locationAt;
  OS.isDatabase = isDatabase;
  OS.lookupAt = lookupAt;
  OS.getVisibleAssets = getVisibleAssets;
  OS.resolveUnlock = resolveUnlock;

  if (typeof module !== "undefined" && module.exports) module.exports = OS;
})(typeof globalThis !== "undefined" ? globalThis : this);
